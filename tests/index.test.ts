const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  compose,
  split,
  head,
  nth,
  groupBy,
  map,
  reduce,
  omit
} = require("ramda");
const { getInstalledPathSync } = require("get-installed-path");
const NewRelicLambdaLayerPlugin = require("../src/index");

const serverlessPath = getInstalledPathSync("serverless", { local: true });
const AwsProvider = require(`${serverlessPath}/lib/plugins/aws/provider/awsProvider`);
const CLI = require(`${serverlessPath}/lib/classes/CLI`);
const Serverless = require(`${serverlessPath}/lib/Serverless`);
const fixturesPath = path.resolve(__dirname, "fixtures");

const buildTestCases = () => {
  const testCaseFiles = fs.readdirSync(fixturesPath);
  const testCaseFileType = compose(
    nth(1),
    split(".")
  );
  const testCaseContentsFromFiles = reduce((acc: object, fileName: string) => {
    const contents = JSON.parse(
      fs.readFileSync(path.resolve(fixturesPath, fileName))
    );
    const fileType = testCaseFileType(fileName);
    return { ...acc, [fileType]: contents };
  }, {});

  const testCaseFilesByName = groupBy(
    compose(
      head,
      split(".")
    )
  )(testCaseFiles);
  const testCases = map((caseName: string) => {
    const testCaseContents = testCaseContentsFromFiles(
      testCaseFilesByName[caseName]
    );

    return { ...testCaseContents, caseName };
  }, Object.keys(testCaseFilesByName));

  return testCases;
};

describe("NewRelicLambdaLayerPlugin", () => {
  const stage = "dev";
  const options = { stage };

  describe("run", () => {
    buildTestCases().forEach(({ caseName, input, output }) => {
      it(`generates the correct service configuration: test case ${caseName}`, async () => {
        const serverless = new Serverless(options);
        Object.assign(serverless.service, input);
        serverless.cli = new CLI(serverless);
        serverless.config.servicePath = os.tmpdir();
        serverless.setProvider("aws", new AwsProvider(serverless, options));
        const plugin = new NewRelicLambdaLayerPlugin(serverless, options);

        try {
          await plugin.hooks['before:deploy:function:packageFunction']();
        } catch (err) {}
        

        expect(
          omit(
            [
              "serverless",
              "package",
              "pluginsData",
              "resources",
              "serviceObject"
            ],
            serverless.service
          )
        ).toEqual(output);
      });
    });
  });
});
