import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NeonControlPlane } from "../lib/db/postgres/neon-control-plane";
import { ProductionGuardError } from "../lib/db/postgres/production-guard";
import {
  checkCodes, checkConfiguration, checkNeon, checkRehearsalConfiguration, checkRehearsalNeon, checkRuntimeManifest,
  parseRuntimeManifest, RUNTIME_OFF_FLAGS, checkServer, compareLedger, formatResult, ledgerResult, libraryResult,
  loadMigrationArtifacts, parseCheckArguments, readOnlyGuard, requireRemoteFlag, roleResult, runDatabaseChecks, schemaResult,
  snapshotResult, snapshotShape, summarise,
} from "../lib/deployment/check-production";
import type { CheckResult, DatabaseCheckInput, Queryable } from "../lib/deployment/check-production";

const folder = path.resolve("db/postgres-migrations");
const artifacts = loadMigrationArtifacts(folder);
const seen = new Set<string>();
const track = <T extends CheckResult | CheckResult[]>(value: T): T => {
  for (const r of Array.isArray(value) ? value : [value]) seen.add(r.code);
  return value;
};
const codes = (results: CheckResult[]) => results.map((r) => `${r.check}:${r.code}`);

const direct = "ep-prod-fixture.us-east-2.aws.neon.tech";
const pooled = "ep-prod-fixture-pooler.us-east-2.aws.neon.tech";
const project = "synthetic-project-123";
const branch = "br-synthetic-production";
// Built at runtime from neutral parts so no key-shaped literal sits in the source.
const part = (...pieces: string[]) => pieces.join("");
const secrets = {
  password: part("pw", "-", "Zk39Hq", "-", "fixture"), resend: part("re", "_", "fixture", "Key", "123456"),
  auth: part("auth", "-", "secret", "-", "0123456789".repeat(2), "-", "abcdef"), neon: part("napi", "_", "fixture", "Key", "987654"),
};
function pgUrl(host: string, database: string, user = "fixture", password: string): string {
  const url = new URL(`postgres://${host}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}
const env: Record<string, string | undefined> = {
  DATABASE_ENV: "production",
  DATABASE_URL: pgUrl(pooled, "app", "fixture", secrets.password),
  DATABASE_URL_UNPOOLED: pgUrl(direct, "app", "fixture", secrets.password),
  DATABASE_PRODUCTION_HOST: pooled, DATABASE_DIRECT_PRODUCTION_HOST: direct,
  BETTER_AUTH_URL: "https://meals.example.test", PRODUCTION_ORIGIN: "https://meals.example.test", BETTER_AUTH_SECRET: secrets.auth,
  RESEND_API_KEY: secrets.resend, AUTH_EMAIL_FROM: "kitchen@meals.example.test",
  NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: branch, NEON_API_KEY: secrets.neon,
};
const ciEnv = { ...env, GITHUB_ACTIONS: "true" };

describe("configuration", () => {
  it("passes a complete production configuration", () => {
    const results = track(checkConfiguration(env));
    expect(results.every((r) => r.severity === "ok")).toBe(true);
  });

  const failing: [string, Record<string, string | undefined>, string, string][] = [
    ["missing pooled URL", { DATABASE_URL: undefined }, "config.database", "CONFIG_MISSING"],
    ["missing direct pin", { DATABASE_DIRECT_PRODUCTION_HOST: undefined }, "config.database", "CONFIG_MISSING"],
    ["wrong DATABASE_ENV", { DATABASE_ENV: "development" }, "config.database", "CONFIG_MISSING"],
    ["unparseable URL", { DATABASE_URL_UNPOOLED: "not a url" }, "config.database", "CONFIG_MALFORMED"],
    ["pins that do not match the URLs", { DATABASE_PRODUCTION_HOST: "ep-other-pooler.us-east-2.aws.neon.tech" }, "config.database", "CONFIG_URL_PAIR_MISMATCH"],
    ["different database", { DATABASE_URL_UNPOOLED: pgUrl(direct, "other", "fixture", secrets.password) }, "config.database", "CONFIG_URL_PAIR_MISMATCH"],
    ["different credentials", { DATABASE_URL_UNPOOLED: pgUrl(direct, "app", "fixture", "other") }, "config.database", "CONFIG_URL_PAIR_MISMATCH"],
    ["pooler used as the direct URL", { DATABASE_URL_UNPOOLED: env.DATABASE_URL, DATABASE_DIRECT_PRODUCTION_HOST: pooled }, "config.database", "CONFIG_URL_PAIR_MISMATCH"],
    ["pair of different endpoints", {
      DATABASE_URL_UNPOOLED: pgUrl("ep-another.us-east-2.aws.neon.tech", "app", "fixture", secrets.password),
      DATABASE_DIRECT_PRODUCTION_HOST: "ep-another.us-east-2.aws.neon.tech",
    }, "config.database", "CONFIG_URL_PAIR_MISMATCH"],
    ["missing auth URL", { BETTER_AUTH_URL: undefined }, "config.auth", "CONFIG_MISSING"],
    ["http auth URL", { BETTER_AUTH_URL: "http://meals.example.test" }, "config.auth", "CONFIG_MALFORMED"],
    ["short auth secret", { BETTER_AUTH_SECRET: "short" }, "config.auth", "CONFIG_MALFORMED"],
    ["different origin", { BETTER_AUTH_URL: "https://elsewhere.example.test" }, "config.auth", "CONFIG_ORIGIN_MISMATCH"],
    ["missing mail key", { RESEND_API_KEY: undefined }, "config.mail", "CONFIG_MISSING"],
    ["malformed sender", { AUTH_EMAIL_FROM: "nobody" }, "config.mail", "CONFIG_MALFORMED"],
    ["missing Neon key", { NEON_API_KEY: undefined }, "config.neon", "CONFIG_MISSING"],
    ["branch name instead of id", { NEON_PRODUCTION_BRANCH_ID: "production" }, "config.neon", "CONFIG_MALFORMED"],
    ["bootstrap secret", { HOUSEHOLD_BOOTSTRAP_SECRET: "x".repeat(40) }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["fixture mailbox", { AUTH_TEST_MAILBOX: "http://127.0.0.1:1" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["owner email", { HOUSEHOLD_OWNER_EMAIL: "owner@example.test" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["push private key", { VAPID_PRIVATE_KEY: "x" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["reminder scheduler secret", { REMINDER_SCHEDULER_SECRET: "x" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["sync scheduler secret", { STATE_SYNC_SCHEDULER_SECRET: "x" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["state repo key", { STATE_GITHUB_PRIVATE_KEY: "x" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["vault repo key", { VAULT_GITHUB_PRIVATE_KEY: "x" }, "config.forbidden", "CONFIG_FORBIDDEN_SET"],
    ["state sync enabled", { STATE_SYNC_ENABLED: "true" }, "config.flags", "CONFIG_FLAG_ENABLED"],
    ["reminders enabled", { REMINDER_SCHEDULER_ENABLED: "1" }, "config.flags", "CONFIG_FLAG_ENABLED"],
    ["vault enabled", { VAULT_ENABLED: "true" }, "config.flags", "CONFIG_FLAG_ENABLED"],
    ["photo review enabled", { PHOTO_REVIEW_ENABLED: "true" }, "config.flags", "CONFIG_FLAG_ENABLED"],
  ];
  it.each(failing)("fails on %s", (_name, change, check, code) => {
    const results = track(checkConfiguration({ ...env, ...change }));
    expect(results.find((r) => r.check === check)).toMatchObject({ severity: "fail", code });
  });

  it("accepts flags explicitly set to false", () => {
    const results = checkConfiguration({ ...env, STATE_SYNC_ENABLED: "false", REMINDER_SCHEDULER_ENABLED: "false", VAULT_ENABLED: "false", PHOTO_REVIEW_ENABLED: "false" });
    expect(results.every((r) => r.severity === "ok")).toBe(true);
  });
});

describe("Neon control plane", () => {
  const endpoint = { id: "ep-prod-fixture", host: direct, project_id: project, branch_id: branch, type: "read_write" };
  const fake = (over: Partial<NeonControlPlane> = {}): NeonControlPlane => ({
    project: async () => ({ id: project }),
    branch: async () => ({ id: branch, project_id: project, name: "main", current_state: "ready" }),
    endpoints: async () => [endpoint],
    branches: async () => [],
    ...over,
  });
  const guard = (code: ConstructorParameters<typeof ProductionGuardError>[0]) => async (): Promise<never> => {
    throw new ProductionGuardError(code, "fixture");
  };

  it("passes when project, branch, readiness and both endpoints agree", async () => {
    expect(track(await checkNeon(env, fake()))).toMatchObject({ severity: "ok", code: "NEON_OK" });
  });
  it.each([
    ["project mismatch", { project: async () => ({ id: "other" }) }, "NEON_PROJECT_MISMATCH"],
    ["branch mismatch", { branch: async () => ({ id: "br-other", project_id: project, name: "x", current_state: "ready" }) }, "NEON_BRANCH_MISMATCH"],
    ["branch not ready", { branch: async () => ({ id: branch, project_id: project, name: "x", current_state: "init" }) }, "NEON_BRANCH_NOT_READY"],
    ["endpoint mismatch", { endpoints: async () => [{ ...endpoint, host: "ep-x.us-east-2.aws.neon.tech", id: "ep-x" }] }, "NEON_ENDPOINT_MISMATCH"],
    ["unreachable", { project: guard("PRODUCTION_NEON_UNREACHABLE") }, "NEON_UNREACHABLE"],
    ["invalid metadata", { branch: guard("PRODUCTION_NEON_INVALID") }, "NEON_INVALID"],
    ["unexpected failure", { branch: async () => { throw new Error("boom"); } }, "NEON_INVALID"],
  ] as const)("fails on %s", async (_name, over, code) => {
    expect(track(await checkNeon(env, fake(over)))).toMatchObject({ severity: "fail", code });
  });
  it("reports missing pins", async () => {
    expect(track(await checkNeon({ ...env, NEON_PROJECT_ID: undefined }, fake()))).toMatchObject({ code: "NEON_CONFIG_MISSING" });
  });
});

async function migrated(): Promise<PGlite> {
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: folder });
  return client;
}
const open: PGlite[] = [];
async function database(version?: string): Promise<PGlite> {
  const client = await migrated();
  open.push(client);
  if (version) await client.query("insert into library_state (key, version) values ('library', $1)", [version]);
  return client;
}
afterAll(async () => { for (const client of open) await client.close(); });

const localVersion = "local-fingerprint-fixture";
const now = new Date("2026-10-26T12:00:00Z");
const fresh = { name: "pre-deploy-20261026T1150", created_at: "2026-10-26T11:50:00Z" };
const plane = (branches: { id?: string; name: string; created_at: string }[] = [fresh]): NeonControlPlane => ({
  project: async () => ({ id: project }),
  branch: async () => ({ id: branch, project_id: project, name: "main", current_state: "ready" }),
  endpoints: async () => [],
  branches: async () => branches.map((b, i) => ({ id: b.id ?? `br-${i}`, ...b })),
});
const input = (client: Queryable, over: Partial<DatabaseCheckInput> = {}): DatabaseCheckInput => ({
  client, env: ciEnv, phase: "pre-deploy", artifacts, localLibraryVersion: localVersion, plane: plane(), now, ...over,
});

describe("database checks on a real migrated schema", () => {
  it("passes every check when ledger, schema, library and snapshot are current", async () => {
    const results = track(await runDatabaseChecks(input(await database(localVersion))));
    expect(codes(results)).toEqual([
      "connect:CONNECT_OK", "role:ROLE_NOT_ENFORCED", "ledger:LEDGER_EXACT", "schema:SCHEMA_OK", "library:LIBRARY_OK", "snapshot:SNAPSHOT_OK",
    ]);
    expect(results.every((r) => r.severity === "ok")).toBe(true);
    expect(summarise(results, "pre-deploy")).toBe("RESULT PASS phase=pre-deploy");
  });

  describe("server", () => {
    it("rejects an unsupported or unreadable version", async () => {
      const version = (value: unknown): Queryable => ({ query: async () => ({ rows: [{ server_version_num: value }] }) });
      expect(track(await checkServer(version("130004")))).toMatchObject({ code: "SERVER_VERSION_UNSUPPORTED", detail: "major=13" });
      expect(track(await checkServer(version("garbage")))).toMatchObject({ code: "CONNECT_FAILED" });
      expect(await checkServer(version("170004"))).toMatchObject({ code: "CONNECT_OK", detail: "major=17" });
    });
  });

  describe("migration ledger", () => {
    it("reports pending migrations, allowed before migrating and refused before deploying", async () => {
      const client = await database(localVersion);
      const extra = { hash: "unapplied", folderMillis: Date.now() };
      const longer = { ...artifacts, expected: [...artifacts.expected, extra], snapshots: [...artifacts.snapshots, artifacts.snapshots.at(-1)!] };
      const before = track(await runDatabaseChecks(input(client, { phase: "pre-migrate", artifacts: longer })));
      expect(before.find((r) => r.check === "ledger")).toMatchObject({ severity: "ok", code: "LEDGER_PENDING", detail: "pending=1" });
      // Schema is compared with the last applied migration, so pending work is not reported as drift.
      expect(before.find((r) => r.check === "schema")).toMatchObject({ severity: "ok", code: "SCHEMA_OK" });
      const deploy = track(await runDatabaseChecks(input(client, { artifacts: longer })));
      expect(deploy.find((r) => r.check === "ledger")).toMatchObject({ severity: "fail", code: "LEDGER_PENDING" });
      expect(summarise(deploy, "pre-deploy")).toContain("FAIL");
    });

    it.each([
      ["a changed hash", "update drizzle.__drizzle_migrations set hash = 'tampered' where id = 3"],
      ["an unknown extra row", "insert into drizzle.__drizzle_migrations (hash, created_at) values ('unknown', 4102444800000)"],
      ["a changed timestamp", "update drizzle.__drizzle_migrations set created_at = created_at + 1 where id = 2"],
    ])("is divergent with %s in every phase", async (_name, statement) => {
      const client = await database(localVersion);
      await client.query(statement);
      for (const phase of ["pre-migrate", "pre-deploy"] as const) {
        const results = track(await runDatabaseChecks(input(client, { phase })));
        expect(results.find((r) => r.check === "ledger")).toMatchObject({ severity: "fail", code: "LEDGER_DIVERGENT" });
        expect(results.find((r) => r.check === "schema")).toMatchObject({ severity: "fail", code: "SCHEMA_SKIPPED" });
      }
    });

    it("treats a missing ledger as every migration pending", async () => {
      const client = new PGlite();
      open.push(client);
      const results = track(await runDatabaseChecks(input(client, { phase: "pre-migrate" })));
      expect(results.find((r) => r.check === "ledger")).toMatchObject({ severity: "ok", code: "LEDGER_PENDING", detail: `pending=${artifacts.expected.length}` });
      expect(results.find((r) => r.check === "schema")).toMatchObject({ code: "SCHEMA_OK" });
      expect(results.find((r) => r.check === "library")).toMatchObject({ severity: "warn", code: "LIBRARY_MISSING" });
    });

    it("compares pure inputs", () => {
      expect(compareLedger([], [])).toMatchObject({ state: "exact" });
      expect(ledgerResult({ state: "exact", applied: 1, pending: 0 }, "pre-deploy").severity).toBe("ok");
    });
  });

  describe("schema drift", () => {
    it.each([
      ["a dropped column", "alter table library_state drop column version", "missing_columns=1"],
      ["an extra column", "alter table library_state add column surprise text", "extra_columns=1"],
      ["an extra table", "create table stray_table (id int)", "extra_tables=1"],
      ["a dropped table", "drop table library_state", "missing_tables=1"],
    ])("fails on %s", async (_name, statement, detail) => {
      const client = await database();
      await client.query(statement);
      const result = (await runDatabaseChecks(input(client))).find((r) => r.check === "schema")!;
      track(result);
      expect(result).toMatchObject({ severity: "fail", code: "SCHEMA_DRIFT" });
      expect(result.detail).toContain(detail);
    });
    it("fails without a snapshot", () => {
      expect(track(schemaResult(undefined, new Map()))).toMatchObject({ code: "SCHEMA_SKIPPED" });
    });
    it("reads the expected shape from a drizzle snapshot", () => {
      expect(snapshotShape({ tables: { "public.t": { name: "t", schema: "", columns: { a: { name: "a" } } } } }).get("t")).toEqual(new Set(["a"]));
    });
  });

  describe("library fingerprint", () => {
    it("is stale when the database was seeded from other content", async () => {
      const client = await database("old-fingerprint");
      expect(track((await runDatabaseChecks(input(client))).find((r) => r.check === "library")!)).toMatchObject({ severity: "fail", code: "LIBRARY_STALE" });
      expect((await runDatabaseChecks(input(client, { phase: "pre-migrate" }))).find((r) => r.check === "library")).toMatchObject({ severity: "warn", code: "LIBRARY_STALE" });
    });
    it("is missing when the table has no library row", async () => {
      const client = await database();
      expect(track((await runDatabaseChecks(input(client))).find((r) => r.check === "library")!)).toMatchObject({ severity: "fail", code: "LIBRARY_MISSING" });
    });
    it("compares equal versions", () => {
      expect(libraryResult("a", "a", "pre-deploy").code).toBe("LIBRARY_OK");
      // The runtime compatibility window never relaxes the deployment gate: a older-but-seeded version is stale.
      expect(libraryResult("newer", "a", "pre-deploy")).toMatchObject({ severity: "fail", code: "LIBRARY_STALE" });
    });
  });

  describe("pre-deploy snapshot branch", () => {
    it("fails when the newest snapshot is too old, using the newest of several", async () => {
      const client = await database(localVersion);
      const old = { name: "pre-deploy-old", created_at: "2026-10-26T08:00:00Z" };
      expect((await runDatabaseChecks(input(client, { plane: plane([old, fresh]) }))).find((r) => r.check === "snapshot")).toMatchObject({ code: "SNAPSHOT_OK" });
      const stale = track((await runDatabaseChecks(input(client, { plane: plane([old]) }))).find((r) => r.check === "snapshot")!);
      expect(stale).toMatchObject({ severity: "fail", code: "SNAPSHOT_STALE", detail: "age_min=240,max_min=60" });
    });
    it("fails when only unrelated branches exist; warns before migrating", async () => {
      const client = await database(localVersion);
      const other = plane([{ name: "main", created_at: "2026-10-26T11:59:00Z" }]);
      expect(track((await runDatabaseChecks(input(client, { plane: other }))).find((r) => r.check === "snapshot")!)).toMatchObject({ severity: "fail", code: "SNAPSHOT_MISSING" });
      expect((await runDatabaseChecks(input(client, { plane: other, phase: "pre-migrate" }))).find((r) => r.check === "snapshot")).toMatchObject({ severity: "warn", code: "SNAPSHOT_MISSING" });
    });
    it("reports an unreachable control plane", async () => {
      const client = await database(localVersion);
      const broken: NeonControlPlane = { ...plane(), branches: async () => { throw new ProductionGuardError("PRODUCTION_NEON_UNREACHABLE", "x"); } };
      expect((await runDatabaseChecks(input(client, { plane: broken }))).find((r) => r.check === "snapshot")).toMatchObject({ severity: "fail", code: "NEON_UNREACHABLE" });
    });
    it("ignores future clocks and unparseable dates", () => {
      expect(snapshotResult([{ name: "pre-deploy-x", created_at: "2026-10-26T13:00:00Z" }], now, "pre-deploy").detail).toBe("age_min=0");
      expect(snapshotResult([{ name: "pre-deploy-x", created_at: "nonsense" }], now, "pre-deploy").code).toBe("SNAPSHOT_MISSING");
    });
  });
});

describe("laptop runs", () => {
  it("require --remote-read-only", () => {
    expect(track(requireRemoteFlag({}, parseCheckArguments([])) as CheckResult)).toMatchObject({ severity: "fail", code: "RUN_REFUSED_FLAG" });
    expect(requireRemoteFlag({}, parseCheckArguments(["--remote-read-only"]))).toBeUndefined();
    expect(requireRemoteFlag({ GITHUB_ACTIONS: "true" }, parseCheckArguments([]))).toBeUndefined();
  });
  it("parses phases and rejects unknown arguments", () => {
    expect(parseCheckArguments([])).toEqual({ phase: "pre-deploy", remoteReadOnly: false, target: "production" });
    expect(parseCheckArguments(["--phase=pre-migrate", "--remote-read-only"])).toEqual({ phase: "pre-migrate", remoteReadOnly: true, target: "production" });
    expect(parseCheckArguments(["--target=rehearsal"])).toMatchObject({ target: "rehearsal" });
    expect(parseCheckArguments(["--runtime-manifest=/tmp/m.json"])).toMatchObject({ runtimeManifest: "/tmp/m.json" });
    expect(parseCheckArguments(["--phase=pre-migrate", "--runtime-manifest=/tmp/m.json"]))
      .toEqual({ phase: "pre-migrate", remoteReadOnly: false, target: "production", runtimeManifest: "/tmp/m.json", phaseExplicit: true });
    expect(parseCheckArguments(["--runtime-manifest=/tmp/m.json", "--phase=pre-deploy"])).toMatchObject({ phase: "pre-deploy", phaseExplicit: true });
    expect(() => parseCheckArguments(["--runtime-manifest="])).toThrow("Usage");
    expect(() => parseCheckArguments(["--runtime-manifest=m.json", "--target=rehearsal"])).toThrow("Usage");
    expect(() => parseCheckArguments(["--runtime-manifest=m.json", "--remote-read-only"])).toThrow("Usage");
    expect(() => parseCheckArguments(["--phase=other"])).toThrow("Usage");
    expect(() => parseCheckArguments(["--write"])).toThrow("Usage");
  });

  it("refuse a write-capable role and accept a read-only one", async () => {
    const client = await database(localVersion);
    // The embedded engine's default role is a superuser, the strongest write-capable case.
    expect(track(await roleResult(client, env))).toMatchObject({ severity: "fail", code: "ROLE_WRITE_CAPABLE" });
    await client.exec(`
      create role reader nologin;
      revoke create on schema public from public;
      grant usage on schema public, drizzle to reader;
      grant select on all tables in schema public to reader;
      grant select on all tables in schema drizzle to reader;
      set role reader;`);
    expect(track(await roleResult(client, env))).toMatchObject({ severity: "ok", code: "ROLE_READ_ONLY" });
    const full = await runDatabaseChecks(input(client, { env }));
    expect(full.find((r) => r.check === "role")).toMatchObject({ code: "ROLE_READ_ONLY" });
    expect(full.every((r) => r.severity === "ok")).toBe(true);
    // A role that can write the library table is refused even when it is not a superuser.
    await client.exec("reset role; grant insert on library_state to reader; set role reader;");
    expect(await roleResult(client, env)).toMatchObject({ code: "ROLE_WRITE_CAPABLE" });
    await client.exec("reset role;");
  });
});

describe("the transaction is read-only", () => {
  it("rejects writes at the database level inside BEGIN READ ONLY", async () => {
    const client = await database(localVersion);
    await client.query("begin read only");
    await expect(client.query("insert into library_state (key, version) values ('x', 'y')")).rejects.toThrow(/read-only transaction/);
    await client.query("rollback");
  });

  it("never sends anything except begin read only, reads and rollback, and changes nothing", async () => {
    const client = await database(localVersion);
    const statements: string[] = [];
    const recording: Queryable = { query: (text) => { statements.push(text); return client.query(text); } };
    const snapshot = async () => JSON.stringify([
      (await client.query("select * from library_state order by key")).rows,
      (await client.query("select hash, created_at from drizzle.__drizzle_migrations order by id")).rows,
      (await client.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows,
    ]);
    const before = await snapshot();
    await runDatabaseChecks(input(recording));
    expect(statements[0]).toBe("begin read only");
    expect(statements.at(-1)).toBe("rollback");
    for (const statement of statements.slice(1, -1)) expect(statement).toMatch(/^(set local statement_timeout|select|show)\b/i);
    expect(await snapshot()).toBe(before);
    // Always rolled back, even when a read fails midway.
    const failing: Queryable = { query: (text) => (/library_state/.test(text) && /to_jsonb/.test(text) ? Promise.reject(new Error("boom")) : client.query(text)) };
    await expect(runDatabaseChecks(input(failing))).rejects.toThrow("boom");
    expect((await client.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);
    expect((await client.query("show transaction_read_only")).rows[0]).toEqual({ transaction_read_only: "off" });
  });

  it.each([
    "insert into library_state values ('a', 'b')", "update library_state set version = 'x'", "delete from library_state",
    "drop table library_state", "create table t (id int)", "select 1; delete from library_state", "commit", "truncate library_state",
    "select pg_advisory_lock(1); drop table x",
  ])("refuses %s before it reaches the database", (statement) => {
    const guarded = readOnlyGuard({ query: async () => { throw new Error("must not reach the database"); } });
    expect(() => guarded.query(statement)).toThrow("CHECK_ERROR");
  });
});

describe("output never contains values", () => {
  const sensitive = [
    secrets.password, secrets.resend, secrets.auth, secrets.neon, direct, pooled, "meals.example.test", "kitchen@", project, branch,
    localVersion, "fixture:",
  ];
  const render = (results: CheckResult[]) => [...results.map(formatResult), summarise(results, "pre-deploy")].join("\n");

  it("holds across passing and failing configurations, database checks and refusals", async () => {
    const client = await database("seeded-hash-value-9f8e7d");
    const bad = {
      ...env, HOUSEHOLD_BOOTSTRAP_SECRET: "bootstrap-secret-value-0123456789-abcdef", STATE_SYNC_ENABLED: "true",
      BETTER_AUTH_URL: "https://elsewhere.example.test", DATABASE_URL_UNPOOLED: pgUrl(direct, "other", "fixture", secrets.password),
    };
    const outputs = [
      render(checkConfiguration(env)), render(checkConfiguration(bad)),
      render(await runDatabaseChecks(input(client))),
      render(await runDatabaseChecks(input(client, { phase: "pre-migrate", plane: plane([]) }))),
      render([requireRemoteFlag({}, parseCheckArguments([]))!]),
    ].join("\n");
    for (const value of [...sensitive, "bootstrap-secret-value", "seeded-hash-value", "elsewhere.example.test", "postgres://", "https://"]) {
      expect(outputs).not.toContain(value);
    }
    for (const line of outputs.split("\n")) expect(line).toMatch(/^(OK|WARN|FAIL|RESULT) [A-Za-z0-9_=.,: -]+$/);
  });

  it("holds for the command itself, which refuses on a laptop before any network use", () => {
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(
      process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/check-production.ts", ...args],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    const noFlag = run([]);
    expect(noFlag.status).toBe(1);
    expect(noFlag.stdout).toContain("FAIL run RUN_REFUSED_FLAG");
    // With the flag but no configuration it stops at the configuration checks, before any connection.
    const noConfig = run(["--remote-read-only"], { DATABASE_URL: pgUrl(pooled, "app", "u", secrets.password) });
    expect(noConfig.status).toBe(1);
    expect(noConfig.stdout).toContain("SKIPPED_PREREQUISITE");
    seen.add("SKIPPED_PREREQUISITE");
    expect(noConfig.stdout + noConfig.stderr).not.toContain(secrets.password);
    expect(noConfig.stdout + noConfig.stderr).not.toContain(pooled);
    const bad = run(["--bogus"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("CHECK_ERROR");
    seen.add("CHECK_ERROR");
  });
});

describe("migration artifacts", () => {
  it("pair every migration with its snapshot", () => {
    expect(artifacts.snapshots).toHaveLength(artifacts.expected.length);
    expect(artifacts.snapshots.at(-1)!.has("library_state")).toBe(true);
  });
});


// ---------------------------------------------------------------------------------------------------------------
// Rehearsal target
// ---------------------------------------------------------------------------------------------------------------

describe("rehearsal target", () => {
  const rehearsalHost = "ep-rehearse-fixture.us-east-2.aws.neon.tech";
  const developmentBranch = "br-synthetic-rehearsal";
  const rehearsalEnv: Record<string, string | undefined> = {
    DATABASE_ENV: "development", GITHUB_ACTIONS: "true",
    DATABASE_URL_UNPOOLED: pgUrl(rehearsalHost, "app", "fixture", secrets.password), DATABASE_NONPRODUCTION_HOST: rehearsalHost,
    NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: branch, NEON_DEVELOPMENT_BRANCH_ID: developmentBranch, NEON_API_KEY: secrets.neon,
  };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const rehearsalPlane = (over: { branch?: Record<string, unknown>; status?: number; throws?: boolean; endpoints?: unknown } = {}) => vi.fn<typeof fetch>(async (url) => {
    if (over.throws) throw new Error("offline");
    if (over.status) return reply({}, over.status);
    if (String(url).endsWith("/endpoints")) {
      return reply({ endpoints: over.endpoints ?? [{ id: "ep-rehearse-fixture", host: rehearsalHost, branch_id: developmentBranch, project_id: project, type: "read_write" }] });
    }
    return reply({ branch: { id: developmentBranch, project_id: project, name: "rehearse-0123456-1", default: false, primary: false, protected: false, current_state: "ready", ...over.branch } });
  });

  it("uses the development target rules and needs no auth, mail or snapshot configuration", async () => {
    expect(track(checkRehearsalConfiguration(rehearsalEnv))).toEqual([{ check: "config.rehearsal", severity: "ok", code: "CONFIG_OK" }]);
    expect(track(await checkRehearsalNeon(rehearsalEnv, rehearsalPlane()))).toMatchObject({ severity: "ok", code: "NEON_OK" });
    const client = await database(localVersion);
    const results = track(await runDatabaseChecks(input(client, { env: rehearsalEnv, target: "rehearsal" })));
    expect(codes(results)).toEqual(["connect:CONNECT_OK", "role:ROLE_NOT_ENFORCED", "ledger:LEDGER_EXACT", "schema:SCHEMA_OK", "library:LIBRARY_OK"]);
    const withoutPlane = { ...input(client, { env: rehearsalEnv, target: "rehearsal" }) };
    delete withoutPlane.plane;
    expect(await runDatabaseChecks(withoutPlane)).toHaveLength(5);
  });

  it("keeps the ledger and library checks for a copy of production before its migration", async () => {
    const results = await runDatabaseChecks(input(await database(), { env: rehearsalEnv, target: "rehearsal", phase: "pre-migrate" }));
    expect(codes(results)).toContain("library:LIBRARY_MISSING");
  });

  it("fails closed on missing, production-like or malformed configuration", () => {
    const failing: [Record<string, string | undefined>, string][] = [
      [{ DATABASE_ENV: "production" }, "CONFIG_MISSING"], [{ DATABASE_URL_UNPOOLED: undefined }, "CONFIG_MISSING"],
      [{ NEON_DEVELOPMENT_BRANCH_ID: undefined }, "CONFIG_MISSING"], [{ DATABASE_NONPRODUCTION_HOST: "elsewhere.example.test" }, "CONFIG_URL_PAIR_MISMATCH"],
      [{ NEON_DEVELOPMENT_BRANCH_ID: branch }, "NEON_BRANCH_MISMATCH"],
      [{ DATABASE_URL_UNPOOLED: pgUrl("localhost", "app", "fixture", secrets.password), DATABASE_NONPRODUCTION_HOST: "localhost" }, "CONFIG_MALFORMED"],
    ];
    for (const [over, code] of failing) {
      const [result] = track(checkRehearsalConfiguration({ ...rehearsalEnv, ...over }));
      expect(result).toMatchObject({ severity: "fail", code });
    }
  });

  it("maps every control-plane failure to a stable code", async () => {
    const cases: [Parameters<typeof rehearsalPlane>[0], string, Record<string, string | undefined>?][] = [
      [{ throws: true }, "NEON_UNREACHABLE"], [{ status: 500 }, "NEON_INVALID"], [{ branch: { current_state: "init" } }, "NEON_BRANCH_MISMATCH"],
      [{ branch: { protected: true } }, "NEON_BRANCH_MISMATCH"], [{ endpoints: [] }, "NEON_BRANCH_MISMATCH"],
      [{}, "NEON_CONFIG_MISSING", { NEON_PROJECT_ID: undefined }],
    ];
    for (const [over, code, extra] of cases) {
      expect(track(await checkRehearsalNeon({ ...rehearsalEnv, ...extra }, rehearsalPlane(over)))).toMatchObject({ severity: "fail", code });
    }
    const incomplete = vi.fn<typeof fetch>(async () => reply({ branch: { id: developmentBranch } }));
    expect(await checkRehearsalNeon(rehearsalEnv, incomplete)).toMatchObject({ code: "NEON_INVALID" });
    const nonJson = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    expect(await checkRehearsalNeon(rehearsalEnv, nonJson)).toMatchObject({ code: "NEON_INVALID" });
    // A non-Error rejection and the default fetch argument both degrade to a stable code.
    const odd = vi.fn<typeof fetch>(async () => { throw "string"; });
    expect(await checkRehearsalNeon(rehearsalEnv, odd)).toMatchObject({ code: "NEON_UNREACHABLE" });
    vi.stubGlobal("fetch", rehearsalPlane());
    expect(await checkRehearsalNeon(rehearsalEnv)).toMatchObject({ code: "NEON_OK" });
    vi.unstubAllGlobals();
    expect(await checkRehearsalNeon({})).toMatchObject({ code: "NEON_BRANCH_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Vercel runtime manifest
// ---------------------------------------------------------------------------------------------------------------

describe("runtime manifest", () => {
  const origin = "https://meals.example.test";
  const github: Record<string, string | undefined> = {
    PRODUCTION_ORIGIN: origin, DATABASE_PRODUCTION_HOST: pooled, NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: branch,
    AUTH_EMAIL_FROM: "kitchen@meals.example.test", BLOB_STORE: "neon", BLOB_BUCKET: "meals-bucket",
  };
  const sensitiveNames = ["DATABASE_URL", "BETTER_AUTH_SECRET", "RESEND_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SIGNUP_ALLOWLIST"];
  const plainValues: Record<string, string> = {
    DATABASE_ENV: "production", DATABASE_PRODUCTION_HOST: pooled, NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: branch,
    BETTER_AUTH_URL: `${origin}/`, AUTH_EMAIL_FROM: "kitchen@meals.example.test", BLOB_STORE: "neon", BLOB_BUCKET: "meals-bucket",
    AWS_ENDPOINT_URL_S3: "https://storage.example.test", AWS_REGION: "aws-us-east-2", APP_TZ: "America/Toronto", MAIL_DAILY_CAP: "60",
    PRIVACY_CONTACT_EMAIL: "privacy@meals.example.test",
    ...Object.fromEntries(RUNTIME_OFF_FLAGS.map((flag) => [flag, "false"])),
  };
  const entries = (over: Record<string, { type: string; value?: string } | null> = {}) => {
    const all: Record<string, { type: string; value?: string } | null> = {
      ...Object.fromEntries(sensitiveNames.map((name) => [name, { type: "sensitive" }])),
      ...Object.fromEntries(Object.entries(plainValues).map(([name, value]) => [name, { type: "plain", value }])),
      ...over,
    };
    return Object.entries(all).filter(([, v]) => v !== null).map(([key, v]) => ({ key, target: ["production"], ...v }));
  };
  const check = (over: Record<string, { type: string; value?: string } | null> = {}, extraGithub: Record<string, string | undefined> = {}) =>
    track(checkRuntimeManifest(parseRuntimeManifest(entries(over)), { ...github, ...extraGithub }));
  const failed = (results: CheckResult[]) => results.filter((r) => r.severity === "fail").map((r) => `${r.check}:${r.code}:${r.detail}`);

  it("passes the intended production runtime, both as a list and as a project env response", () => {
    expect(failed(check())).toEqual([]);
    const wrapped = checkRuntimeManifest(parseRuntimeManifest({ envs: entries() }), github);
    expect(failed(wrapped)).toEqual([]);
  });

  it("keeps the off-feature flag list in one constant", () => {
    expect([...RUNTIME_OFF_FLAGS]).toEqual(["STATE_SYNC_ENABLED", "REMINDER_SCHEDULER_ENABLED", "VAULT_ENABLED", "PHOTO_REVIEW_ENABLED", "LEGACY_IMPORT_ENABLED"]);
  });

  it("ignores variables of other targets and reads no value of a sensitive one", () => {
    const manifest = parseRuntimeManifest([
      ...entries(),
      { key: "NEON_API_KEY", type: "plain", value: "x", target: ["preview", "development"] },
      { key: "HOUSEHOLD_OWNER_EMAIL", type: "plain", value: "x", target: "preview" },
      { key: "BETTER_AUTH_SECRET", type: "sensitive", value: secrets.auth, target: ["production"] },
      { key: "STATE_SYNC_ENABLED", type: "plain", target: ["production"] },
      { key: "ALL_TARGETS_FLAG", type: "plain", value: "1" },
    ]);
    expect(manifest!.has("NEON_API_KEY")).toBe(false);
    expect(manifest!.has("HOUSEHOLD_OWNER_EMAIL")).toBe(false);
    expect(manifest!.get("BETTER_AUTH_SECRET")).toEqual({ type: "sensitive" });
    expect(manifest!.get("STATE_SYNC_ENABLED")).toEqual({ type: "plain" });
    expect(manifest!.get("ALL_TARGETS_FLAG")).toEqual({ type: "plain", value: "1" });
  });

  it("fails on a malformed manifest", () => {
    for (const bad of [null, "x", { envs: "nope" }, [{ key: "A" }], [{ key: "", type: "plain" }]]) {
      expect(failed(track(checkRuntimeManifest(parseRuntimeManifest(bad), github)))).toEqual(["runtime.manifest:CONFIG_MALFORMED:manifest"]);
    }
  });

  it("requires every name, secrets to be sensitive, and forbidden names absent", () => {
    expect(failed(check({ RESEND_API_KEY: null, APP_TZ: null, PHOTO_REVIEW_ENABLED: null })))
      .toEqual(["runtime.required:CONFIG_MISSING:RESEND_API_KEY,APP_TZ,PHOTO_REVIEW_ENABLED"]);
    expect(failed(check({ BETTER_AUTH_SECRET: { type: "plain", value: secrets.auth }, DATABASE_URL: { type: "plain" } })))
      .toEqual(["runtime.secrets:CONFIG_MALFORMED:DATABASE_URL,BETTER_AUTH_SECRET"]);
    const forbidden = failed(check({
      NEON_API_KEY: { type: "sensitive" }, DATABASE_URL_UNPOOLED: { type: "sensitive" }, DEPLOYMENT_ENVIRONMENT: { type: "plain", value: "production" },
      VAPID_PUBLIC_KEY: { type: "plain", value: "x" }, STATE_GITHUB_APP_ID: { type: "plain", value: "x" }, VAULT_PASSPHRASE: { type: "sensitive" },
      HOUSEHOLD_BOOTSTRAP_SECRET: { type: "sensitive" }, AUTH_TEST_MAILBOX: { type: "plain", value: "x" },
    }));
    expect(forbidden).toEqual([
      "runtime.forbidden:CONFIG_FORBIDDEN_SET:AUTH_TEST_MAILBOX,DATABASE_URL_UNPOOLED,DEPLOYMENT_ENVIRONMENT,HOUSEHOLD_BOOTSTRAP_SECRET,NEON_API_KEY,STATE_GITHUB_APP_ID,VAPID_PUBLIC_KEY,VAULT_PASSPHRASE",
    ]);
  });

  it("requires every off-feature flag to be the plain value false", () => {
    for (const flag of RUNTIME_OFF_FLAGS) {
      expect(failed(check({ [flag]: { type: "plain", value: "true" } }))).toEqual([`runtime.flags:CONFIG_FLAG_ENABLED:${flag}`]);
    }
    expect(failed(check({ VAULT_ENABLED: { type: "sensitive" }, LEGACY_IMPORT_ENABLED: { type: "plain" } })))
      .toEqual(["runtime.flags:CONFIG_FLAG_ENABLED:VAULT_ENABLED,LEGACY_IMPORT_ENABLED"]);
    expect(failed(check({ STATE_SYNC_ENABLED: { type: "plain", value: " false " } }))).toEqual([]);
  });

  it("compares plain values with the GitHub side by name only", () => {
    expect(failed(check({ BETTER_AUTH_URL: { type: "plain", value: "https://elsewhere.example.test" } }))).toEqual(["runtime.values:CONFIG_VALUE_MISMATCH:BETTER_AUTH_URL"]);
    expect(failed(check({ BETTER_AUTH_URL: { type: "plain", value: "not a url" } }))).toEqual(["runtime.values:CONFIG_VALUE_MISMATCH:BETTER_AUTH_URL"]);
    expect(failed(check({
      DATABASE_PRODUCTION_HOST: { type: "plain", value: direct }, NEON_PROJECT_ID: { type: "plain", value: "other-project" },
      NEON_PRODUCTION_BRANCH_ID: { type: "plain", value: "br-other" }, AUTH_EMAIL_FROM: { type: "plain", value: "x@example.test" },
      BLOB_STORE: { type: "plain", value: "s3" }, BLOB_BUCKET: { type: "plain", value: "other-bucket" }, DATABASE_ENV: { type: "plain", value: "development" },
    }))).toEqual(["runtime.values:CONFIG_VALUE_MISMATCH:DATABASE_PRODUCTION_HOST,NEON_PROJECT_ID,NEON_PRODUCTION_BRANCH_ID,AUTH_EMAIL_FROM,BLOB_STORE,BLOB_BUCKET,DATABASE_ENV"]);
    expect(failed(check({}, { PRODUCTION_ORIGIN: undefined }))).toEqual(["runtime.values:CONFIG_VALUE_MISMATCH:PRODUCTION_ORIGIN"]);
    expect(failed(check({ AWS_REGION: { type: "sensitive" } }))).toEqual(["runtime.values:CONFIG_MALFORMED:AWS_REGION"]);
  });

  it("skips the BLOB comparison only when the GitHub side does not carry the value", () => {
    expect(failed(check({}, { BLOB_STORE: undefined, BLOB_BUCKET: " " }))).toEqual([]);
    expect(failed(check({ BLOB_BUCKET: { type: "plain", value: "other" } }, { BLOB_BUCKET: undefined }))).toEqual([]);
  });

  it("prints names only, even for a manifest full of values", () => {
    const manifest = parseRuntimeManifest(entries({
      NEON_API_KEY: { type: "plain", value: secrets.neon }, BETTER_AUTH_URL: { type: "plain", value: "https://elsewhere.example.test" },
      STATE_SYNC_ENABLED: { type: "plain", value: "true" }, DATABASE_PRODUCTION_HOST: { type: "plain", value: secrets.password },
    }));
    const results = checkRuntimeManifest(manifest, github);
    const output = [...results.map(formatResult), summarise(results, "runtime-manifest")].join("\n");
    for (const value of [secrets.neon, secrets.password, "elsewhere.example.test", project, branch, "meals.example.test"]) expect(output).not.toContain(value);
    for (const line of output.split("\n")) expect(line).toMatch(/^(OK|WARN|FAIL|RESULT) [A-Za-z0-9_=.,: -]+$/);
    expect(output).toContain("RESULT FAIL phase=runtime-manifest");
  });

  describe("phase run with a manifest", () => {
    const { BETTER_AUTH_SECRET: _a, RESEND_API_KEY: _r, ...githubSide } = { ...env, ...github } as Record<string, string | undefined>;
    const phaseConfig = (over: Record<string, { type: string; value?: string } | null> = {}, extra: Record<string, string | undefined> = {}) =>
      track(checkConfiguration({ ...githubSide, ...extra }, parseRuntimeManifest(entries(over))));
    const part = (results: CheckResult[], name: string) => results.find((r) => r.check === name);

    it("satisfies auth and mail from the manifest without the two secrets in the environment", () => {
      expect(githubSide.BETTER_AUTH_SECRET).toBeUndefined();
      const results = phaseConfig();
      expect(results.every((r) => r.severity === "ok")).toBe(true);
      expect(checkConfiguration(githubSide).filter((r) => r.severity === "fail").map((r) => r.check)).toEqual(["config.auth", "config.mail"]);
    });

    const cases: [string, Record<string, { type: string; value?: string } | null>, Record<string, string | undefined>, string, string, string?][] = [
      ["secret missing from the manifest", { BETTER_AUTH_SECRET: null }, {}, "config.auth", "CONFIG_MISSING", "BETTER_AUTH_SECRET"],
      ["secret typed plain", { BETTER_AUTH_SECRET: { type: "plain", value: "x" } }, {}, "config.auth", "CONFIG_MALFORMED", "auth"],
      ["auth URL missing from the manifest", { BETTER_AUTH_URL: null }, {}, "config.auth", "CONFIG_MISSING", "BETTER_AUTH_URL"],
      ["auth URL hidden", { BETTER_AUTH_URL: { type: "sensitive" } }, {}, "config.auth", "CONFIG_MALFORMED", "auth"],
      ["auth URL not an origin", { BETTER_AUTH_URL: { type: "plain", value: "http://meals.example.test" } }, {}, "config.auth", "CONFIG_MALFORMED", "auth"],
      ["auth URL for another origin", { BETTER_AUTH_URL: { type: "plain", value: "https://elsewhere.example.test" } }, {}, "config.auth", "CONFIG_ORIGIN_MISMATCH"],
      ["no GitHub origin", {}, { PRODUCTION_ORIGIN: undefined }, "config.auth", "CONFIG_MISSING", "PRODUCTION_ORIGIN"],
      ["mail key missing from the manifest", { RESEND_API_KEY: null }, {}, "config.mail", "CONFIG_MISSING", "RESEND_API_KEY"],
      ["mail key typed plain", { RESEND_API_KEY: { type: "plain", value: "x" } }, {}, "config.mail", "CONFIG_MALFORMED", "mail"],
      ["sender missing from the manifest", { AUTH_EMAIL_FROM: null }, {}, "config.mail", "CONFIG_MISSING", "AUTH_EMAIL_FROM"],
      ["sender hidden", { AUTH_EMAIL_FROM: { type: "sensitive" } }, {}, "config.mail", "CONFIG_MALFORMED", "mail"],
      ["sender with a display name", { AUTH_EMAIL_FROM: { type: "plain", value: "Kitchen <kitchen@meals.example.test>" } }, {}, "config.mail", "CONFIG_MALFORMED", "mail"],
      ["sender differs from GitHub", { AUTH_EMAIL_FROM: { type: "plain", value: "other@meals.example.test" } }, {}, "config.mail", "CONFIG_VALUE_MISMATCH", "AUTH_EMAIL_FROM"],
      ["no GitHub sender", {}, { AUTH_EMAIL_FROM: undefined }, "config.mail", "CONFIG_MISSING", "AUTH_EMAIL_FROM"],
    ];
    it.each(cases)("fails on %s", (_name, over, extra, checkName, code, detail) => {
      expect(part(phaseConfig(over, extra), checkName)).toMatchObject({ severity: "fail", code, ...(detail ? { detail } : {}) });
    });

    it("still runs the database, Neon, forbidden and flag checks", () => {
      expect(part(phaseConfig({}, { DATABASE_URL: undefined }), "config.database")).toMatchObject({ severity: "fail", code: "CONFIG_MISSING" });
      expect(part(phaseConfig({}, { NEON_API_KEY: undefined }), "config.neon")).toMatchObject({ severity: "fail" });
      expect(part(phaseConfig({}, { VAULT_ENABLED: "true" }), "config.flags")).toMatchObject({ severity: "fail" });
    });

    it("never prints a value", () => {
      const output = phaseConfig({ AUTH_EMAIL_FROM: { type: "plain", value: "other@meals.example.test" } }).map(formatResult).join("\n");
      expect(output).not.toContain("example.test");
    });
  });

  it("runs from the command with no network, from a file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
    const file = path.join(dir, "env.json");
    writeFileSync(file, JSON.stringify(entries()));
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(
      process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/check-production.ts", ...args],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    const good = run([`--runtime-manifest=${file}`], Object.fromEntries(Object.entries(github).filter(([, v]) => v) as [string, string][]));
    expect(good.stdout).toContain("RESULT PASS phase=runtime-manifest");
    expect(good.status).toBe(0);
    const mismatch = run([`--runtime-manifest=${file}`], { PRODUCTION_ORIGIN: "https://elsewhere.example.test" });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain("FAIL runtime.values CONFIG_VALUE_MISMATCH");
    const missing = run([`--runtime-manifest=${path.join(dir, "absent.json")}`]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("FAIL runtime.manifest CONFIG_MALFORMED manifest");
    // A phase run with the manifest reads auth and mail from it. No database settings are given, so it stops before any network.
    const ghEnv = { ...Object.fromEntries(Object.entries(github).filter(([, v]) => v) as [string, string][]), GITHUB_ACTIONS: "true" };
    const phase = run(["--phase=pre-migrate", `--runtime-manifest=${file}`], ghEnv);
    expect(phase.status).toBe(1);
    expect(phase.stdout).toContain("OK runtime.required CONFIG_OK");
    expect(phase.stdout).toContain("OK config.auth CONFIG_OK");
    expect(phase.stdout).toContain("OK config.mail CONFIG_OK");
    expect(phase.stdout).toContain("FAIL config.database CONFIG_MISSING");
    expect(phase.stdout).toContain("RESULT FAIL phase=pre-migrate");
    const badFile = path.join(dir, "bad.json");
    writeFileSync(badFile, "{");
    const bad = run(["--phase=pre-deploy", `--runtime-manifest=${badFile}`], ghEnv);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("RESULT FAIL phase=runtime-manifest");
    expect(mismatch.stdout + missing.stdout + good.stdout).not.toContain("elsewhere.example.test");
  }, 120_000);
});

it("exercises every check code", () => {
  expect([...seen].sort()).toEqual([...checkCodes].sort());
});
