import * as fs from "fs-extra";
import * as _ from "lodash";
import * as path from "path";
import * as request from "request-promise-native";
import * as semver from "semver";
// tslint:disable-next-line
import * as Serverless from "serverless";
import { fetchLicenseKey, nerdgraphFetch } from "./api";
import Integration from "./integration";
import { waitForStatus } from "./utils";

const DEFAULT_FILTER_PATTERNS = [
  "REPORT",
  "NR_LAMBDA_MONITORING",
  "Task timed out",
  "RequestId"
];

export default class NewRelicLambdaLayerPlugin {
  public serverless: Serverless;
  public options: Serverless.Options;
  public awsProvider: any;
  public hooks: {
    [event: string]: Promise<any>;
  };
  public licenseKey: string;
  public managedSecretConfigured: boolean;
  public mgdPolicyArns: any[];
  public extFellBackToCW: boolean;

  constructor(serverless: Serverless, options: Serverless.Options) {
    this.serverless = serverless;
    this.options = options;
    this.awsProvider = this.serverless.getProvider("aws") as any;
    this.licenseKey = null;
    this.managedSecretConfigured = false;
    this.mgdPolicyArns = [];
    this.extFellBackToCW = false;

    this.hooks = this.shouldSkipPlugin()
      ? {}
      : {
          "after:deploy:deploy": this.addLogSubscriptions.bind(this),
          "after:deploy:function:packageFunction": this.cleanup.bind(this),
          "after:package:createDeploymentArtifacts": this.cleanup.bind(this),
          "before:deploy:deploy": this.checkIntegration.bind(this),
          "before:deploy:function:packageFunction": this.run.bind(this),
          "before:package:createDeploymentArtifacts": this.run.bind(this),
          "before:remove:remove": this.removeLogSubscriptions.bind(this)
        };
  }

  get region() {
    return _.get(this.serverless.service, "provider.region", "us-east-1");
  }

  get config() {
    return _.get(this.serverless, "service.custom.newRelic", {
      nrRegion: "us"
    });
  }

  get managedPolicyArns() {
    const managedPolicyArns = _.get(
      this.serverless,
      "service.provider.managedPolicyArns",
      false
    );

    return managedPolicyArns || [];
  }

  get resources() {
    return _.get(
      this.serverless,
      "service.provider.compiledCloudFormationTemplate.Resources",
      {}
    );
  }

  get stage() {
    return (
      (this.options && this.options.stage) ||
      (this.serverless.service.provider &&
        this.serverless.service.provider.stage)
    );
  }

  get prependLayer() {
    return typeof this.config.prepend === "boolean" && this.config.prepend;
  }

  get autoSubscriptionDisabled() {
    return (
      typeof this.config.disableAutoSubscription === "boolean" &&
      this.config.disableAutoSubscription &&
      this.extFellBackToCW === false // only disable if ext config worked
    );
  }

  get functions() {
    return Object.assign.apply(
      null,
      this.serverless.service
        .getAllFunctions()
        .map(func => ({ [func]: this.serverless.service.getFunction(func) }))
    );
  }

  get extFallbackMessage() {
    return `
    
********************************************************************************

The variables in the custom block of your serverless.yml show that you've chosen 
to deliver telemetry via our Lambda Extension. The value of your personal 
New Relic API Key, however, was not found in your New Relic account. 
Are you sure you used the correct API key? If not, you can retrieve it from our 
Onboarding nerdlet for AWS Lambda: https://one.nr/0DvwBpoxbjp

For now, your function will still deliver telemetry to New Relic using a 
CloudWatch Log Subscription, but we recommend using the lambda extension.
Please see this link for more information: 
https://blog.newrelic.com/product-news/aws-lambda-extensions-integrations/

********************************************************************************

    `;
  }

  public checkIntegration() {
    return new Integration(this).check();
  }

  public async checkForSecretPolicy() {
    return new Integration(this).checkForManagedSecretPolicy();
  }

  public async regionPolicyValid(current) {
    return (
      current.currentRegionPolicy &&
      current.currentRegionPolicy[0] &&
      current.currentRegionPolicy[0].Arn
    );
  }

  public async configureLicenseForExtension() {
    if (!this.licenseKey) {
      this.licenseKey = await this.retrieveLicenseKey();
      if (!this.licenseKey) {
        this.config.enableExtension = false;
        this.extFellBackToCW = true;
        return;
      }
    }

    // If the managed secret has already been created,
    // there should be policies for it.
    const secretAccess = await this.checkForSecretPolicy();
    let managedSecret;

    if (secretAccess.secretExists) {
      this.managedSecretConfigured = true;
    } else {
      // Secret doesn't exist, so create it
      managedSecret = await new Integration(this).createManagedSecret();
      if (managedSecret && managedSecret.policyArn) {
        this.managedSecretConfigured = true;
      }
    }

    if (secretAccess.currentRegionPolicy.length > 0) {
      const policyArn = secretAccess.currentRegionPolicy[0].Arn;
      this.mgdPolicyArns = [...this.managedPolicyArns, policyArn];
    } else if (this.managedSecretConfigured) {
      this.mgdPolicyArns = [...this.managedPolicyArns, managedSecret.policyArn];
    }
    return;
  }

  public applyPolicies(role) {
    const existingPolicyArns = role.ManagedPolicyArns || [];
    const nrManagedPolicyArns = this.mgdPolicyArns || [];
    role.ManagedPolicyArns = [...existingPolicyArns, ...nrManagedPolicyArns];
  }

  public async run() {
    const version = this.serverless.getVersion();
    if (semver.lt(version, "1.34.0")) {
      this.serverless.cli.log(
        `Serverless ${version} does not support layers. Please upgrade to >=1.34.0.`
      );
      return;
    }

    let plugins = _.get(this.serverless, "service.plugins", []);
    if (!_.isArray(plugins) && plugins.modules) {
      plugins = plugins.modules;
    }
    this.serverless.cli.log(`Plugins: ${JSON.stringify(plugins)}`);
    if (
      plugins.indexOf("serverless-webpack") >
      plugins.indexOf("serverless-newrelic-lambda-layers")
    ) {
      this.serverless.cli.log(
        "serverless-newrelic-lambda-layers plugin must come after serverless-webpack in serverless.yml; skipping."
      );
      return;
    }

    const { exclude = [], include = [] } = this.config;
    if (!_.isEmpty(exclude) && !_.isEmpty(include)) {
      this.serverless.cli.log(
        "exclude and include options are mutually exclusive; skipping."
      );
      return;
    }
    if (this.config.enableExtension !== false) {
      this.config.enableExtension = true;
      // If using the extension, try to store the NR license key in a managed secret
      // for the extension to authenticate. If not, fall back to function environment variable
      await this.configureLicenseForExtension();
    }

    // xray enabled? DT should be off, to avoid duplicating traces/spans.
    if (this.config.enableXRay) {
      this.config.enableDistributedTracing = false;
    }

    // before adding layer, attach secret access policy
    // to each function's execution role:
    const resources = this.resources;

    const xRayPolicy = {
      Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      Effect: "Allow",
      Resource: "*"
    };

    Object.keys(resources)
      .filter(resourceName => resources[resourceName].Type === `AWS::IAM::Role`)
      .forEach(roleResource => {
        this.applyPolicies(resources[roleResource].Properties);
        if (this.config.enableXRay) {
          let policyStatement = _.get(
            resources[roleResource],
            "Properties.Policies[0].PolicyDocument.Statement",
            []
          );
          policyStatement = [...policyStatement, xRayPolicy];
          resources[
            roleResource
          ].Properties.Policies[0].PolicyDocument.Statement = policyStatement;
        }
        return;
      });

    const funcs = this.functions;
    const promises = [];

    for (const funcName of Object.keys(funcs)) {
      const funcDef = funcs[funcName];
      promises.push(this.addLayer(funcName, funcDef));
    }

    await Promise.all(promises);
  }

  public cleanup() {
    this.removeNodeHelper();
  }

  public async addLogSubscriptions() {
    if (this.autoSubscriptionDisabled) {
      this.serverless.cli.log(
        "Skipping adding log subscription. Explicitly disabled"
      );
      return;
    }

    const funcs = this.functions;
    let { cloudWatchFilter = [...DEFAULT_FILTER_PATTERNS] } = this.config;

    let cloudWatchFilterString = "";
    if (
      typeof cloudWatchFilter === "object" &&
      cloudWatchFilter.indexOf("*") === -1
    ) {
      cloudWatchFilter = cloudWatchFilter.map(el => `?\"${el}\"`);
      cloudWatchFilterString = cloudWatchFilter.join(" ");
    } else if (cloudWatchFilter.indexOf("*") === -1) {
      cloudWatchFilterString = String(cloudWatchFilter);
    }

    this.serverless.cli.log(`log filter: ${cloudWatchFilterString}`);

    const promises = [];

    for (const funcName of Object.keys(funcs)) {
      if (this.shouldSkipFunction(funcName)) {
        return;
      }

      this.serverless.cli.log(
        `Configuring New Relic log subscription for ${funcName}`
      );

      const funcDef = funcs[funcName];
      promises.push(
        this.ensureLogSubscription(funcDef.name, cloudWatchFilterString)
      );
    }

    await Promise.all(promises);

    if (this.extFellBackToCW) {
      this.serverless.cli.log(this.extFallbackMessage);
    }
  }

  public async removeLogSubscriptions() {
    if (this.autoSubscriptionDisabled) {
      this.serverless.cli.log(
        "Skipping removing log subscription. Explicitly disabled"
      );
      return;
    }
    const funcs = this.functions;
    const promises = [];

    for (const funcName of Object.keys(funcs)) {
      const { name } = funcs[funcName];
      this.serverless.cli.log(
        `Removing New Relic log subscription for ${funcName}`
      );
      promises.push(this.removeSubscriptionFilter(name));
    }

    await Promise.all(promises);
  }

  private async addLayer(funcName: string, funcDef: any) {
    this.serverless.cli.log(`Adding NewRelic layer to ${funcName}`);

    if (!this.region) {
      this.serverless.cli.log(
        "No AWS region specified for NewRelic layer; skipping."
      );
      return;
    }

    const {
      name,
      environment = {},
      handler,
      runtime = _.get(this.serverless.service, "provider.runtime"),
      layers = [],
      package: pkg = {}
    } = funcDef;

    if (!this.config.accountId && !environment.NEW_RELIC_ACCOUNT_ID) {
      this.serverless.cli.log(
        `No New Relic Account ID specified for "${funcName}"; skipping.`
      );
      return;
    }

    const wrappableRuntime =
      [
        "nodejs10.x",
        "nodejs12.x",
        "nodejs14.x",
        "nodejs8.10",
        "python2.7",
        "python3.6",
        "python3.7",
        "python3.8"
      ].indexOf(runtime) === -1;

    if (
      typeof runtime !== "string" ||
      (wrappableRuntime && !this.config.enableExtension)
    ) {
      this.serverless.cli.log(
        `Unsupported runtime "${runtime}" for NewRelic layer; skipping.`
      );
      return;
    }

    if (this.shouldSkipFunction(funcName)) {
      return;
    }

    const layerArn = this.config.layerArn
      ? this.config.layerArn
      : await this.getLayerArn(runtime);

    const newRelicLayers = layers.filter(
      layer => typeof layer === "string" && layer.match(layerArn)
    );

    // Note: This is if the user specifies a layer in their serverless.yml
    if (newRelicLayers.length) {
      this.serverless.cli.log(
        `Function "${funcName}" already specifies an NewRelic layer; skipping.`
      );
    } else {
      if (this.prependLayer) {
        layers.unshift(layerArn);
      } else {
        layers.push(layerArn);
      }

      funcDef.layers = layers;
    }

    environment.NEW_RELIC_LAMBDA_HANDLER = handler;

    if (this.config.logEnabled === true) {
      this.logLevel(environment);
    }

    environment.NEW_RELIC_NO_CONFIG_FILE = environment.NEW_RELIC_NO_CONFIG_FILE
      ? environment.NEW_RELIC_NO_CONFIG_FILE
      : "true";

    environment.NEW_RELIC_APP_NAME = environment.NEW_RELIC_APP_NAME
      ? environment.NEW_RELIC_APP_NAME
      : name || funcName;

    environment.NEW_RELIC_ACCOUNT_ID = environment.NEW_RELIC_ACCOUNT_ID
      ? environment.NEW_RELIC_ACCOUNT_ID
      : this.config.accountId;

    if (this.config.enableDistributedTracing) {
      environment.NEW_RELIC_DISTRIBUTED_TRACING_ENABLED = "true";
    }

    environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY = environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
      ? environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
      : environment.NEW_RELIC_ACCOUNT_ID
      ? environment.NEW_RELIC_ACCOUNT_ID
      : this.config.trustedAccountKey;

    if (runtime.match("python")) {
      environment.NEW_RELIC_SERVERLESS_MODE_ENABLED = "true";
    }

    if (this.config.enableExtension) {
      environment.NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "true";
      if (!this.managedSecretConfigured && this.licenseKey) {
        environment.NEW_RELIC_LICENSE_KEY = this.licenseKey;
      }

      if (this.config.enableFunctionLogs) {
        environment.NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS = "true";
        this.config.disableAutoSubscription = true;
      }
    } else {
      environment.NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "false";
    }

    funcDef.environment = environment;
    funcDef.handler = this.getHandlerWrapper(runtime, handler);
    funcDef.package = this.updatePackageExcludes(runtime, pkg);
  }

  private shouldSkipPlugin() {
    if (
      !this.config.stages ||
      (this.config.stages && this.config.stages.includes(this.stage))
    ) {
      return false;
    }

    this.serverless.cli.log(
      `Skipping plugin serverless-newrelic-lambda-layers for stage ${this.stage}`
    );

    return true;
  }

  private shouldSkipFunction(funcName) {
    const { include = [], exclude = [] } = this.config;

    if (
      !_.isEmpty(include) &&
      _.isArray(include) &&
      include.indexOf(funcName) === -1
    ) {
      this.serverless.cli.log(
        `Excluded function ${funcName}; is not part of include skipping`
      );
      return true;
    }

    if (_.isArray(exclude) && exclude.indexOf(funcName) !== -1) {
      this.serverless.cli.log(`Excluded function ${funcName}; skipping`);
      return true;
    }

    return false;
  }

  private logLevel(environment) {
    environment.NEW_RELIC_LOG_ENABLED = "true";
    environment.NEW_RELIC_LOG = environment.NEW_RELIC_LOG
      ? environment.NEW_RELIC_LOG
      : "stdout";

    if (!environment.NEW_RELIC_LOG_LEVEL) {
      const globalNewRelicLogLevel = _.get(
        this.serverless.service,
        "provider.environment.NEW_RELIC_LOG_LEVEL"
      );

      if (globalNewRelicLogLevel) {
        environment.NEW_RELIC_LOG_LEVEL = globalNewRelicLogLevel;
      } else if (this.config.logLevel) {
        environment.NEW_RELIC_LOG_LEVEL = this.config.logLevel;
      } else if (this.config.debug) {
        environment.NEW_RELIC_LOG_LEVEL = "debug";
      } else {
        environment.NEW_RELIC_LOG_LEVEL = "error";
      }
    }
  }

  private async getLayerArn(runtime: string) {
    return request(
      `https://${this.region}.layers.newrelic-external.com/get-layers?CompatibleRuntime=${runtime}`
    ).then(response => {
      const awsResp = JSON.parse(response);
      return _.get(awsResp, "Layers[0].LatestMatchingVersion.LayerVersionArn");
    });
  }

  private getHandlerWrapper(runtime: string, handler: string) {
    if (["nodejs10.x", "nodejs12.x", "nodejs14.x"].indexOf(runtime) !== -1) {
      return "newrelic-lambda-wrapper.handler";
    }

    if (runtime === "nodejs8.10") {
      this.addNodeHelper();
      return "newrelic-wrapper-helper.handler";
    }

    if (runtime.match("python")) {
      return "newrelic_lambda_wrapper.handler";
    }

    return handler;
  }

  private addNodeHelper() {
    const helperPath = path.join(
      this.serverless.config.servicePath,
      "newrelic-wrapper-helper.js"
    );
    if (!fs.existsSync(helperPath)) {
      fs.writeFileSync(
        helperPath,
        "module.exports = require('newrelic-lambda-wrapper');"
      );
    }
  }

  private removeNodeHelper() {
    const helperPath = path.join(
      this.serverless.config.servicePath,
      "newrelic-wrapper-helper.js"
    );

    if (fs.existsSync(helperPath)) {
      fs.removeSync(helperPath);
    }
  }

  private updatePackageExcludes(runtime: string, pkg: any) {
    if (!runtime.match("nodejs")) {
      return pkg;
    }

    const { exclude = [] } = pkg;
    exclude.push("!newrelic-wrapper-helper.js");
    pkg.exclude = exclude;
    return pkg;
  }

  private async ensureLogSubscription(
    funcName: string,
    cloudWatchFilterString: string
  ) {
    try {
      await this.awsProvider.request("Lambda", "getFunction", {
        FunctionName: funcName
      });
    } catch (err) {
      if (err.providerError) {
        this.serverless.cli.log(err.providerError.message);
      }
      return;
    }

    let destinationArn;

    const {
      logIngestionFunctionName = "newrelic-log-ingestion",
      apiKey
    } = this.config;

    try {
      destinationArn = await this.getDestinationArn(logIngestionFunctionName);
    } catch (err) {
      this.serverless.cli.log(
        `Could not find a \`${logIngestionFunctionName}\` function installed.`
      );
      this.serverless.cli.log(
        "Details about setup requirements are available here: https://docs.newrelic.com/docs/serverless-function-monitoring/aws-lambda-monitoring/get-started/enable-new-relic-monitoring-aws-lambda#enable-process"
      );
      if (err.providerError) {
        this.serverless.cli.log(err.providerError.message);
      }
      if (!apiKey) {
        this.serverless.cli.log(
          "Unable to create newrelic-log-ingestion because New Relic API key not configured."
        );
        return;
      }

      this.serverless.cli.log(
        `creating required newrelic-log-ingestion function in region ${this.region}`
      );
      await this.addLogIngestionFunction();
      return;
    }

    let subscriptionFilters;

    try {
      subscriptionFilters = await this.describeSubscriptionFilters(funcName);
    } catch (err) {
      if (err.providerError) {
        this.serverless.cli.log(err.providerError.message);
      }
      return;
    }

    const competingFilters = subscriptionFilters.filter(
      filter => filter.filterName !== "NewRelicLogStreaming"
    );

    if (competingFilters.length) {
      this.serverless.cli.log(
        "WARNING: Found a log subscription filter that was not installed by New Relic. This may prevent the New Relic log subscription filter from being installed. If you know you don't need this log subscription filter, you should first remove it and rerun this command. If your organization requires this log subscription filter, please contact New Relic at serverless@newrelic.com for assistance with getting the AWS log subscription filter limit increased."
      );
    }

    const existingFilters = subscriptionFilters.filter(
      filter => filter.filterName === "NewRelicLogStreaming"
    );

    if (existingFilters.length) {
      this.serverless.cli.log(
        `Found log subscription for ${funcName}, verifying configuration`
      );

      await Promise.all(
        existingFilters
          .filter(filter => filter.filterPattern !== cloudWatchFilterString)
          .map(async filter => this.removeSubscriptionFilter(funcName))
          .map(async filter =>
            this.addSubscriptionFilter(
              funcName,
              destinationArn,
              cloudWatchFilterString
            )
          )
      );
    } else {
      this.serverless.cli.log(
        `Adding New Relic log subscription to ${funcName}`
      );

      await this.addSubscriptionFilter(
        funcName,
        destinationArn,
        cloudWatchFilterString
      );
    }
  }

  private async getDestinationArn(logIngestionFunctionName: string) {
    return this.awsProvider
      .request("Lambda", "getFunction", {
        FunctionName: logIngestionFunctionName
      })
      .then(res => res.Configuration.FunctionArn);
  }

  private async addLogIngestionFunction() {
    const templateUrl = await this.getSarTemplate();
    if (!templateUrl) {
      this.serverless.cli.log(
        "Unable to create newRelic-log-ingestion without sar template."
      );
      return;
    }

    try {
      const mode = "CREATE";
      const stackName = "NewRelic-log-ingestion";
      const changeSetName = `${stackName}-${mode}-${Date.now()}`;
      const parameters = await this.formatFunctionVariables();

      const params = {
        Capabilities: ["CAPABILITY_IAM"],
        ChangeSetName: changeSetName,
        ChangeSetType: mode,
        Parameters: parameters,
        StackName: stackName,
        TemplateURL: templateUrl
      };

      const { Id, StackId } = await this.awsProvider.request(
        "CloudFormation",
        "createChangeSet",
        params
      );

      this.serverless.cli.log(
        "Waiting for change set creation to complete, this may take a minute..."
      );

      await waitForStatus(
        {
          awsMethod: "describeChangeSet",
          callbackMethod: () => this.executeChangeSet(Id, StackId),
          methodParams: { ChangeSetName: Id },
          statusPath: "Status"
        },
        this
      );
    } catch (err) {
      this.serverless.cli.log(
        "Unable to create newrelic-log-ingestion function. Please verify that required environment variables have been set."
      );
    }
  }

  private async retrieveLicenseKey() {
    const { apiKey, accountId, nrRegion } = this.config;
    const userData = await nerdgraphFetch(
      apiKey,
      nrRegion,
      fetchLicenseKey(accountId)
    );
    this.licenseKey = _.get(userData, "data.actor.account.licenseKey", null);
    return this.licenseKey;
  }

  private async formatFunctionVariables() {
    const { logEnabled } = this.config;
    const licenseKey = this.licenseKey
      ? this.licenseKey
      : await this.retrieveLicenseKey();
    const loggingVar = logEnabled ? "True" : "False";

    return [
      {
        ParameterKey: "NRLoggingEnabled",
        ParameterValue: `${loggingVar}`
      },
      {
        ParameterKey: "NRLicenseKey",
        ParameterValue: `${licenseKey}`
      }
    ];
  }

  private async getSarTemplate() {
    try {
      const data = await this.awsProvider.request(
        "ServerlessApplicationRepository",
        "createCloudFormationTemplate",
        {
          ApplicationId:
            "arn:aws:serverlessrepo:us-east-1:463657938898:applications/NewRelic-log-ingestion"
        }
      );

      const { TemplateUrl } = data;
      return TemplateUrl;
    } catch (err) {
      this.serverless.cli.log(
        `Something went wrong while fetching the sar template: ${err}`
      );
    }
  }

  private async executeChangeSet(changeSetName: string, stackId: string) {
    try {
      await this.awsProvider.request("CloudFormation", "executeChangeSet", {
        ChangeSetName: changeSetName
      });
      this.serverless.cli.log(
        "Waiting for newrelic-log-ingestion install to complete, this may take a minute..."
      );

      await waitForStatus(
        {
          awsMethod: "describeStacks",
          callbackMethod: () => this.addLogSubscriptions(),
          methodParams: { StackName: stackId },
          statusPath: "Stacks[0].StackStatus"
        },
        this
      );
    } catch (changeSetErr) {
      this.serverless.cli.log(
        `Something went wrong while executing the change set: ${changeSetErr}`
      );
    }
  }

  private async describeSubscriptionFilters(funcName: string) {
    return this.awsProvider
      .request("CloudWatchLogs", "describeSubscriptionFilters", {
        logGroupName: `/aws/lambda/${funcName}`
      })
      .then(res => res.subscriptionFilters);
  }

  private async addSubscriptionFilter(
    funcName: string,
    destinationArn: string,
    cloudWatchFilterString: string
  ) {
    return this.awsProvider
      .request("CloudWatchLogs", "putSubscriptionFilter", {
        destinationArn,
        filterName: "NewRelicLogStreaming",
        filterPattern: cloudWatchFilterString,
        logGroupName: `/aws/lambda/${funcName}`
      })
      .catch(err => {
        if (err.providerError) {
          this.serverless.cli.log(err.providerError.message);
        }
      });
  }

  private removeSubscriptionFilter(funcName: string) {
    return this.awsProvider
      .request("CloudWatchLogs", "DeleteSubscriptionFilter", {
        filterName: "NewRelicLogStreaming",
        logGroupName: `/aws/lambda/${funcName}`
      })
      .catch(err => {
        if (err.providerError) {
          this.serverless.cli.log(err.providerError.message);
        }
      });
  }
}

module.exports = NewRelicLambdaLayerPlugin;
