export const nerdgraphFetch = async (
  apiKey: string,
  region: string,
  query: string
) => {
  const gqlUrl = region.includes("eu")
    ? "https://api.eu.newrelic.com/graphql"
    : "https://api.newrelic.com/graphql";

  const res = await fetch(gqlUrl, {
    body: JSON.stringify({ query }),
    headers: {
      "API-Key": apiKey,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  return res.json();
};

export const cloudLinkAccountMutation = (
  accountId: number,
  roleArn: string,
  linkedAccount: string
) => `
  mutation {
    cloudLinkAccount(accountId: ${accountId}, accounts: {aws: [{arn: "${roleArn}", name: "${linkedAccount}"}]}) {
      linkedAccounts {
        id
        name
      }
      errors {
          message
      }
    }
  }
`;

export const cloudServiceIntegrationMutation = (
  accountId: number,
  provider: string,
  service: string,
  linkedAccountId: number
) => `
  mutation {
    cloudConfigureIntegration (
      accountId: ${accountId},
      integrations: {${provider}: {${service}: {linkedAccountId: ${linkedAccountId}}}}
    ) {
      integrations {
        id
        name
        service {
          id
          name
        }
      }
      errors {
        linkedAccountId
        message
      }
    }
  }
`;

export const fetchLinkedAccounts = (accountId: number) => `
  query {
    actor {
      account(id: ${accountId}) {
        cloud {
          linkedAccounts {
            id
            name
            createdAt
            updatedAt
            authLabel
            externalId
            nrAccountId
          }
        }
      }
    }
  }
`;

export const fetchLicenseKey = (accountId: number) => `
  {
    actor {
      account(id: ${accountId}) {
        licenseKey
        name
        id
      }
    }
  }
`;
