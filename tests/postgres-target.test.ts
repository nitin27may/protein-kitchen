import { describe, expect, it } from "vitest";
import { validatePostgresTarget } from "../lib/db/postgres/target";
import type { PostgresTarget } from "../lib/db/postgres/target";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";

const remote = Object.assign(new URL("postgresql://ep-fixture-pooler.example.neon.tech/app"), {
  username: "fixture", password: "secret",
}).toString();
const dev: PostgresTarget = { connectionString: remote, runtimeEnvironment: "development", databaseEnvironment: "development" };

describe("Postgres connection safety", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("allows explicit local test connections to %s", (host) => {
    expect(validatePostgresTarget({ ...dev, connectionString: `postgres://fixture@${host}/app` }).hostname).toBe(host);
  });

  describe("Postgres migration target", () => {
    it.each([undefined, "preview", "typo"])("refuses environment %s before opening a connection", (DATABASE_ENV) => {
      expect(() => postgresMigrationTarget({ DATABASE_ENV })).toThrow("Preview is not enabled");
    });

    it("does not fall back to a possibly production application URL", () => {
      expect(() => postgresMigrationTarget({ DATABASE_ENV: "development", DATABASE_URL: remote })).toThrow("DATABASE_URL_UNPOOLED");
    });

    it("requires review of the direct endpoint and refuses the Neon pooler", () => {
      const env = { DATABASE_ENV: "development", DATABASE_URL_UNPOOLED: remote, DATABASE_NONPRODUCTION_HOST: new URL(remote).hostname };
      expect(() => postgresMigrationTarget(env)).toThrow("direct endpoint");
      const direct = remote.replace("-pooler", "");
      expect(() => postgresMigrationTarget({ ...env, DATABASE_URL_UNPOOLED: direct })).toThrow("non-production endpoint");
      expect(postgresMigrationTarget({ ...env, DATABASE_URL_UNPOOLED: direct, DATABASE_NONPRODUCTION_HOST: new URL(direct).hostname }))
        .toMatchObject({ databaseEnvironment: "development", runtimeEnvironment: "development", connectionString: direct });
    });

    it("allows a local test database without reading configuration files", () => {
      expect(postgresMigrationTarget({ DATABASE_ENV: "test", DATABASE_URL_UNPOOLED: "postgres://localhost/fixture" }))
        .toMatchObject({ databaseEnvironment: "test", connectionString: "postgres://localhost/fixture" });
    });
  });

  it("refuses remote development without a reviewed exact endpoint", () => {
    expect(() => validatePostgresTarget(dev)).toThrow("non-production endpoint");
    expect(() => validatePostgresTarget({ ...dev, nonProductionHost: "another.example.neon.tech" })).toThrow("non-production endpoint");
    const url = validatePostgresTarget({ ...dev, nonProductionHost: new URL(remote).hostname });
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it.each(["development", "test", "preview"] as const)("refuses a production database in %s", (runtimeEnvironment) => {
    expect(() => validatePostgresTarget({ ...dev, runtimeEnvironment, databaseEnvironment: "production" })).toThrow("must match");
  });

  it("allows an explicitly selected production target only in production, and only with its host pin", () => {
    const production = { ...dev, runtimeEnvironment: "production", databaseEnvironment: "production" } as const;
    expect(() => validatePostgresTarget(production)).toThrow("PRODUCTION_PIN_MISSING");
    expect(() => validatePostgresTarget({ ...production, productionHost: "another.example.neon.tech" })).toThrow("PRODUCTION_HOST_MISMATCH");
    expect(validatePostgresTarget({ ...production, productionHost: new URL(remote).hostname }).hostname)
      .toBe(new URL(remote).hostname);
  });

  it.each(["not-a-url", "https://example.com/app", "postgres://localhost"])("rejects malformed or non-Postgres targets: %s", (connectionString) => {
    expect(() => validatePostgresTarget({ ...dev, connectionString })).toThrow();
  });

  it.each(["host", "hostaddr", "port", "dbname", "service", "servicefile"])("rejects %s overrides of the reviewed target", (key) => {
    expect(() => validatePostgresTarget({ ...dev, connectionString: `postgres://localhost/app?${key}=other` })).toThrow("must not override");
  });

  it.each(["ssl=false", "sslmode=disable", "sslmode=no-verify", "sslmode=require"])("rejects insecure TLS settings: %s", (query) => {
    expect(() => validatePostgresTarget({ ...dev, connectionString: `${remote}?${query}`, nonProductionHost: new URL(remote).hostname })).toThrow("verify-full");
  });

  it("does not include credentials in validation errors", () => {
    try {
      validatePostgresTarget(dev);
      expect.fail("target should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain(remote);
    }
  });
});
