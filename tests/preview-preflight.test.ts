import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { previewPreflight } from "../lib/deployment/preflight";

const database = (host: string) => Object.assign(new URL(`postgres://${host}/app`), {
  username: "fixture", password: "synthetic",
}).toString();
const env = {
  VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", DATABASE_ENV: "preview",
  DATABASE_URL: database("ep-fixture-pooler.us-east-2.aws.neon.tech"),
  DATABASE_URL_UNPOOLED: database("ep-fixture.us-east-2.aws.neon.tech"),
  DATABASE_NONPRODUCTION_HOST: "ep-fixture-pooler.us-east-2.aws.neon.tech",
  DATABASE_DIRECT_NONPRODUCTION_HOST: "ep-fixture.us-east-2.aws.neon.tech",
  NEON_PROJECT_ID: "synthetic-project", NEON_DEVELOPMENT_BRANCH_ID: "br-fixture", NEON_PRODUCTION_BRANCH_ID: "br-production",
  NEON_API_KEY: "PRIVATE_SYNTHETIC_API_KEY",
  BETTER_AUTH_URL: "https://preview.example.test", BETTER_AUTH_SECRET: "synthetic-secret-not-real".repeat(2),
  BLOB_STORE: "neon", BLOB_BUCKET: "synthetic-private",
  AWS_ENDPOINT_URL_S3: "https://br-fixture.storage.c-1.us-east-2.aws.neon.tech",
  AWS_REGION: "us-east-2", AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "PRIVATE_SYNTHETIC_STORAGE",
};
describe("protected preview read-only configuration evidence", () => {
  it("performs no network by default and never exposes values", async () => {
    const verify = vi.fn();
    const report = await previewPreflight(env, false, verify);
    expect(report).toEqual({ configurationValid: true, liveBranchVerified: false, failed: [] });
    expect(verify).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|postgres:|example.test|synthetic/);
    expect(await previewPreflight(env)).toEqual(report);
  });
  it("verifies both reviewed endpoint mappings only when explicitly requested", async () => {
    const verify = vi.fn(async () => {});
    expect(await previewPreflight(env, true, verify)).toEqual({ configurationValid: true, liveBranchVerified: true, failed: [] });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]).toBeDefined();
  });
  it("refuses unavailable or failed live metadata without echoing provider bodies", async () => {
    const verify = vi.fn(async () => { throw new Error("PRIVATE_PROVIDER_BODY"); });
    expect(await previewPreflight(env, true, verify)).toEqual({ configurationValid: true, liveBranchVerified: false, failed: ["live-branch"] });
  });
  it.each([
    ["VERCEL", ""], ["VERCEL_ENV", "production"], ["NODE_ENV", "development"], ["DATABASE_ENV", "production"],
    ["DATABASE_URL", ""], ["DATABASE_URL_UNPOOLED", ""], ["DATABASE_NONPRODUCTION_HOST", ""],
    ["DATABASE_DIRECT_NONPRODUCTION_HOST", ""],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED.replace("/app", "/other")],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED.replace("fixture:synthetic@", "other:synthetic@")],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED.replace(":synthetic@", ":different@")],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED.replace("/app", ":5433/app")],
    ["NEON_PROJECT_ID", "../private"], ["NEON_DEVELOPMENT_BRANCH_ID", "main"], ["NEON_PRODUCTION_BRANCH_ID", ""],
    ["NEON_DEVELOPMENT_BRANCH_ID", env.NEON_PRODUCTION_BRANCH_ID], ["NEON_API_KEY", ""],
    ["BETTER_AUTH_URL", "http://localhost:3000"], ["BETTER_AUTH_SECRET", ""],
    ["BETTER_AUTH_URL", "https://localhost"], ["BETTER_AUTH_URL", "https://127.0.0.1"],
    ["BETTER_AUTH_URL", "https://[::1]"],
    ["HOUSEHOLD_BOOTSTRAP_SECRET", "synthetic-bootstrap".repeat(3)],
    ["BLOB_STORE", "filesystem"], ["AWS_ENDPOINT_URL_S3", "https://br-production.storage.c-1.us-east-2.aws.neon.tech"],
    ["STATE_SYNC_ENABLED", "true"], ["REMINDER_SCHEDULER_ENABLED", "true"], ["VAULT_ENABLED", "true"],
    ["REMINDER_SCHEDULER_SECRET", "PRIVATE"], ["STATE_SYNC_SCHEDULER_SECRET", "PRIVATE"], ["VAULT_GITHUB_PRIVATE_KEY", "PRIVATE"],
    ["VAPID_PRIVATE_KEY", "PRIVATE"], ["RESEND_API_KEY", "PRIVATE"],
    ["AUTH_TEST_MAILBOX", "1"], ["STATE_SYNC_TEST_GITHUB_URL", "http://127.0.0.1"], ["REMINDER_TEST_PUSH_URL", "http://127.0.0.1"],
    ["REMINDER_TEST_PUSH_URL", ""],
    ["NEXT_PUBLIC_DATABASE_URL", "PRIVATE"], ["NEXT_PUBLIC_AUTH_SECRET", "PRIVATE"],
  ])("refuses unsafe %s before any live verification", async (key, value) => {
    const verify = vi.fn();
    const report = await previewPreflight({ ...env, [key]: value }, true, verify);
    expect(report.configurationValid).toBe(false);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(verify).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });
  it("permits explicit off toggles and public nonsecret metadata", async () => {
    expect((await previewPreflight({ ...env, STATE_SYNC_ENABLED: "false", REMINDER_SCHEDULER_ENABLED: "false", VAULT_ENABLED: "false", NEXT_PUBLIC_APP_NAME: "Kitchen" })).configurationValid).toBe(true);
  });
  it("refuses missing pins and accepts explicit matching default ports", async () => {
    expect((await previewPreflight({})).configurationValid).toBe(false);
    for (const key of ["DATABASE_URL_UNPOOLED", "NEON_DEVELOPMENT_BRANCH_ID", "NEON_PRODUCTION_BRANCH_ID"]) {
      expect((await previewPreflight({ ...env, [key]: undefined })).configurationValid).toBe(false);
    }
    expect((await previewPreflight({
      ...env, DATABASE_URL: env.DATABASE_URL.replace("/app", ":5432/app"),
      DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace("/app", ":5432/app"),
    })).configurationValid).toBe(true);
  });
  it("reports missing configuration with stable codes from the actual CLI", async () => {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/preview-preflight.ts"], {
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    }).catch((error: { code: number; stdout: string }) => error);
    expect(result).toMatchObject({ code: 1 });
    expect(result.stdout).toContain('"configurationValid":false');
    expect(result.stdout).toContain("not deployment approval");
  });
});
