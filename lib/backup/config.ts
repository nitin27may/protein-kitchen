import { githubStateConfiguration, type GitHubStateConfiguration } from "../sync/github";

type Environment = Readonly<Record<string, string | undefined>>;

export function vaultConfiguration(env: Environment): GitHubStateConfiguration {
  if (env.VERCEL || env.VERCEL_ENV || !["development", "test"].includes(env.DATABASE_ENV ?? "") ||
      !["development", "test"].includes(env.NODE_ENV ?? "") || env.VAULT_ENABLED !== "true") {
    throw new Error("Vault commands require an explicitly enabled development/test operator host, never Vercel.");
  }
  const configuration = githubStateConfiguration({
    STATE_SYNC_ENABLED: "true",
    STATE_GITHUB_APP_ID: env.VAULT_GITHUB_APP_ID,
    STATE_GITHUB_INSTALLATION_ID: env.VAULT_GITHUB_INSTALLATION_ID,
    STATE_GITHUB_REPOSITORY_ID: env.VAULT_GITHUB_REPOSITORY_ID,
    STATE_GITHUB_OWNER: env.VAULT_GITHUB_OWNER,
    STATE_GITHUB_REPOSITORY: env.VAULT_GITHUB_REPOSITORY,
    STATE_GITHUB_BRANCH: env.VAULT_GITHUB_BRANCH,
    STATE_GITHUB_PRIVATE_KEY: env.VAULT_GITHUB_PRIVATE_KEY,
  });
  if (configuration.repositoryId === Number(env.STATE_GITHUB_REPOSITORY_ID) ||
      `${configuration.owner}/${configuration.repository}`.toLowerCase() ===
      `${env.STATE_GITHUB_OWNER}/${env.STATE_GITHUB_REPOSITORY}`.toLowerCase()) {
    throw new Error("Vault and selective state-sync must use different repositories.");
  }
  return configuration;
}
