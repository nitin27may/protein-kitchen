import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { vaultConfiguration } from "../lib/backup/config";
import { runVaultCommand } from "../lib/backup/operator";
import { fixtureConfiguration } from "./helpers/github-state";

const env = {
  NODE_ENV: "test", DATABASE_ENV: "test", VAULT_ENABLED: "true",
  VAULT_GITHUB_APP_ID: "123", VAULT_GITHUB_INSTALLATION_ID: "456", VAULT_GITHUB_REPOSITORY_ID: "789",
  VAULT_GITHUB_OWNER: fixtureConfiguration.owner, VAULT_GITHUB_REPOSITORY: fixtureConfiguration.repository,
  VAULT_GITHUB_BRANCH: fixtureConfiguration.branch, VAULT_GITHUB_PRIVATE_KEY: fixtureConfiguration.privateKey,
};
describe("explicit separate vault operator configuration", () => {
  it("refuses invalid arguments on the production-default transport without opening it", async () => {
    await expect(runVaultCommand([], {})).rejects.toThrow("Invalid vault command");
  });
  it("uses only the complete separately enabled pinned vault configuration", () => {
    expect(vaultConfiguration(env)).toEqual(fixtureConfiguration);
    expect(vaultConfiguration({ ...env, NODE_ENV: "development", DATABASE_ENV: "development" })).toEqual(fixtureConfiguration);
  });
  it.each([
    { VAULT_ENABLED: "" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" },
    { NODE_ENV: "production" }, { DATABASE_ENV: "production" }, { NODE_ENV: "" }, { DATABASE_ENV: "" },
    { NODE_ENV: undefined }, { DATABASE_ENV: undefined },
    { VAULT_GITHUB_PRIVATE_KEY: "" }, { VAULT_GITHUB_REPOSITORY_ID: "" }, { VAULT_GITHUB_BRANCH: "../bad" },
    { STATE_GITHUB_REPOSITORY_ID: "789" },
    { STATE_GITHUB_REPOSITORY_ID: "0789" },
    { STATE_GITHUB_OWNER: fixtureConfiguration.owner.toUpperCase(), STATE_GITHUB_REPOSITORY: fixtureConfiguration.repository.toUpperCase() },
  ])("refuses unsafe configuration without credential fallback: %s", (patch) => {
    expect(() => vaultConfiguration({ ...env, ...patch })).toThrow();
  });
  it.each([[], ["publish", "PRIVATE_PATH"], ["publish", "PRIVATE_PATH", "--untrusted"], ["fetch", "id", "commit"]])(
    "operator command refuses missing/unsafe arguments without exposing them: %s", async (...args) => {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/vault-postgres.ts", ...args], {
        env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_ENV: "test" },
      }).catch((error: { stderr: string; code: number }) => error);
      expect(result).toMatchObject({ code: 1 });
      expect(result.stderr).toContain("Vault operation failed");
      expect(result.stderr).not.toContain("PRIVATE_PATH");
    },
  );
});
