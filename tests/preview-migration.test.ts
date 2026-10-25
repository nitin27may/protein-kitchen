import { describe, expect, it } from "vitest";
import { previewLibraryTables, previewMigrationTarget, requireMigrationPrefix } from "../lib/deployment/preview-migration";

const env = {
  VERCEL: "1", VERCEL_ENV: "preview", DATABASE_ENV: "preview",
  DATABASE_URL: "postgres://fixture@ep-fixture-pooler.c-6.us-east-2.aws.neon.tech/neondb",
  DATABASE_URL_UNPOOLED: "postgres://fixture@ep-fixture.c-6.us-east-2.aws.neon.tech/neondb",
  DATABASE_DIRECT_NONPRODUCTION_HOST: "ep-fixture.c-6.us-east-2.aws.neon.tech",
  DATABASE_NONPRODUCTION_HOST: "ep-fixture-pooler.c-6.us-east-2.aws.neon.tech",
  NEON_DEVELOPMENT_BRANCH_ID: "br-fixture-dev", NEON_PRODUCTION_BRANCH_ID: "br-fixture-prod",
  PREVIEW_MIGRATION_BRANCH: "br-fixture-dev",
};

describe("isolated operator preview migration contract", () => {
  it("retains preview labels on the direct target", () => {
    expect(previewMigrationTarget(env)).toMatchObject({
      runtimeEnvironment: "preview", databaseEnvironment: "preview",
      connectionString: env.DATABASE_URL_UNPOOLED,
    });
  });

  it.each([
    { DATABASE_ENV: "production" }, { DATABASE_ENV: "development" }, { VERCEL_ENV: "production" },
    { PREVIEW_MIGRATION_BRANCH: "" }, { PREVIEW_MIGRATION_BRANCH: "br-other" },
    { NEON_PRODUCTION_BRANCH_ID: "br-fixture-dev" }, { DATABASE_URL_UNPOOLED: "" },
    { DATABASE_DIRECT_NONPRODUCTION_HOST: "other.neon.tech" },
    { DATABASE_URL_UNPOOLED: "postgres://localhost/fixture" },
    {
      DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace("ep-fixture.", "ep-fixture-pooler."),
      DATABASE_DIRECT_NONPRODUCTION_HOST: env.DATABASE_DIRECT_NONPRODUCTION_HOST.replace("ep-fixture.", "ep-fixture-pooler."),
    },
  ])("refuses unsafe target overrides %j", (overrides) => {
    expect(() => previewMigrationTarget({ ...env, ...overrides })).toThrow();
  });

  it("accepts only an exact ordered ledger prefix, and requires parity after migration", () => {
    const expected = [{ hash: "first", folderMillis: 1 }, { hash: "second", folderMillis: 2 }];
    const first = { hash: "first", created_at: "1" };
    const second = { hash: "second", created_at: "2" };
    expect(() => requireMigrationPrefix([], expected)).not.toThrow();
    expect(() => requireMigrationPrefix([first], expected)).not.toThrow();
    expect(() => requireMigrationPrefix([first, second], expected, true)).not.toThrow();
    for (const rows of [[second], [second, first], [first, { ...second, hash: "wrong" }],
      [first, { ...second, created_at: "3" }], [first, second, second]]) {
      expect(() => requireMigrationPrefix(rows, expected)).toThrow("divergent");
    }
    expect(() => requireMigrationPrefix([first], expected, true)).toThrow("pending");
  });

  it("never permits populated human or operational tables", () => {
    for (const name of ["people", "auth_users", "households", "photos", "sync_state", "preferences", "plans"]) {
      expect(previewLibraryTables.has(name)).toBe(false);
    }
    expect(previewLibraryTables.has("recipes")).toBe(true);
  });
});
