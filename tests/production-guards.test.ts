import { beforeEach, describe, expect, it, vi } from "vitest";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { sqliteImportTarget } from "../lib/db/postgres/import-target";
import { runtimeTarget } from "../lib/db/postgres/runtime-target";
import { ProductionGuardError } from "../lib/db/postgres/production-guard";
import { validatePostgresTarget } from "../lib/db/postgres/target";
import type { PostgresTarget } from "../lib/db/postgres/target";
import type { NeonControlPlane } from "../lib/db/postgres/neon-control-plane";
import { verifyProductionBranch } from "../lib/db/postgres/verify-production";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { openPostgres } from "../lib/db/postgres/client";

vi.mock("../lib/db/postgres/client", () => ({ openPostgres: vi.fn(() => ({ db: {}, pool: {}, close: vi.fn() })) }));

const direct = "ep-prod-fixture.us-east-2.aws.neon.tech";
const pooled = "ep-prod-fixture-pooler.us-east-2.aws.neon.tech";
const project = "synthetic-project-123";
const productionBranch = "br-synthetic-production";
function pgUrl(host: string, database: string, user = "fixture", password = "pw-fixture"): string {
  const url = new URL(`postgres://${host}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}
const directUrl = pgUrl(direct, "app");
const pooledUrl = pgUrl(pooled, "app");

const ci = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", DEPLOYMENT_ENVIRONMENT: "production",
  DATABASE_ENV: "production", DATABASE_URL_UNPOOLED: directUrl, DATABASE_DIRECT_PRODUCTION_HOST: direct,
  NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: productionBranch, NEON_API_KEY: "synthetic-key",
};
const vercel = {
  VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", DATABASE_ENV: "production",
  DATABASE_URL: pooledUrl, DATABASE_PRODUCTION_HOST: pooled,
};

function code(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return error instanceof ProductionGuardError ? error.code : `other:${String(error)}`; }
  return undefined;
}
async function codeAsync(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) { return error instanceof ProductionGuardError ? error.code : `other:${String(error)}`; }
  return undefined;
}

describe("production migration target (CI only)", () => {
  it("is produced in the approved main-branch production CI context", () => {
    expect(postgresMigrationTarget(ci)).toMatchObject({
      connectionString: directUrl, runtimeEnvironment: "production", databaseEnvironment: "production", productionHost: direct,
    });
  });

  it.each([
    ["a laptop (no CI variables)", { GITHUB_ACTIONS: undefined, GITHUB_REF: undefined, DEPLOYMENT_ENVIRONMENT: undefined }],
    ["CI but another branch", { GITHUB_REF: "refs/heads/feat/x" }],
    ["CI on a pull request ref", { GITHUB_REF: "refs/pull/6/merge" }],
    ["a tag ref", { GITHUB_REF: "refs/tags/main" }],
    ["GITHUB_ACTIONS not exactly true", { GITHUB_ACTIONS: "1" }],
    ["a preview-labelled deployment", { DEPLOYMENT_ENVIRONMENT: "preview" }],
    ["a missing deployment marker", { DEPLOYMENT_ENVIRONMENT: undefined }],
    ["a Vercel-labelled preview", { VERCEL_ENV: "preview" }],
    ["a Vercel build", { VERCEL: "1" }],
  ])("refuses %s with a stable code", (_name, change) => {
    expect(code(() => postgresMigrationTarget({ ...ci, ...change }))).toBe("PRODUCTION_CONTEXT_REFUSED");
  });

  it("refuses a laptop before it inspects any URL or pin", () => {
    expect(code(() => postgresMigrationTarget({ DATABASE_ENV: "production" }))).toBe("PRODUCTION_CONTEXT_REFUSED");
  });

  it("refuses the pooler for migrations", () => {
    expect(code(() => postgresMigrationTarget({ ...ci, DATABASE_URL_UNPOOLED: pooledUrl, DATABASE_DIRECT_PRODUCTION_HOST: pooled })))
      .toBe("PRODUCTION_DIRECT_REQUIRED");
  });

  it("refuses a host that differs from the direct pin", () => {
    expect(code(() => postgresMigrationTarget({ ...ci, DATABASE_DIRECT_PRODUCTION_HOST: "ep-other.us-east-2.aws.neon.tech" })))
      .toBe("PRODUCTION_HOST_MISMATCH");
  });

  it.each(["DATABASE_URL_UNPOOLED", "DATABASE_DIRECT_PRODUCTION_HOST"])("refuses a missing %s", (key) => {
    expect(code(() => postgresMigrationTarget({ ...ci, [key]: undefined }))).toBe("PRODUCTION_PIN_MISSING");
  });

  it("does not fall back to the runtime URL or the non-production pin", () => {
    expect(code(() => postgresMigrationTarget({
      ...ci, DATABASE_URL_UNPOOLED: undefined, DATABASE_URL: directUrl, DATABASE_PRODUCTION_HOST: direct, DATABASE_NONPRODUCTION_HOST: direct,
    }))).toBe("PRODUCTION_PIN_MISSING");
  });

  it("keeps libpq host overrides and weak TLS refused", () => {
    expect(() => postgresMigrationTarget({ ...ci, DATABASE_URL_UNPOOLED: `${directUrl}?host=elsewhere.example` })).toThrow("must not override");
    expect(() => postgresMigrationTarget({ ...ci, DATABASE_URL_UNPOOLED: `${directUrl}?sslmode=require` })).toThrow("verify-full");
    expect(validatePostgresTarget(postgresMigrationTarget(ci)).searchParams.get("sslmode")).toBe("verify-full");
  });

  it("never echoes credentials or hosts in a refusal", () => {
    for (const change of [{ GITHUB_REF: "refs/heads/x" }, { DATABASE_DIRECT_PRODUCTION_HOST: "ep-other.neon.tech" }]) {
      try { postgresMigrationTarget({ ...ci, ...change }); } catch (error) {
        expect(String(error)).not.toContain("pw-fixture");
        expect(String(error)).not.toContain(direct);
      }
    }
  });

  it("leaves development and test targets and the loopback rules unchanged", () => {
    expect(postgresMigrationTarget({ DATABASE_ENV: "test", DATABASE_URL_UNPOOLED: "postgres://localhost/fixture" }))
      .toMatchObject({ databaseEnvironment: "test" });
    expect(() => postgresMigrationTarget({ DATABASE_ENV: "preview" })).toThrow("Preview is not enabled");
    expect(() => postgresMigrationTarget({ DATABASE_ENV: "development", DATABASE_URL_UNPOOLED: directUrl })).toThrow("non-production endpoint");
  });
});

describe("SQLite import into production", () => {
  it("is refused from a laptop", () => {
    expect(code(() => sqliteImportTarget({ DATABASE_ENV: "production", SQLITE_IMPORT_NEON_BRANCH_ID: productionBranch }))).toBe("PRODUCTION_CONTEXT_REFUSED");
  });
  it("requires the production branch id in CI, never the development one", () => {
    expect(() => sqliteImportTarget(ci)).toThrow("SQLITE_IMPORT_NEON_BRANCH_ID");
    expect(() => sqliteImportTarget({ ...ci, SQLITE_IMPORT_NEON_BRANCH_ID: "br-dev", NEON_DEVELOPMENT_BRANCH_ID: "br-dev" })).toThrow("SQLITE_IMPORT_NEON_BRANCH_ID");
    expect(sqliteImportTarget({ ...ci, SQLITE_IMPORT_NEON_BRANCH_ID: productionBranch }).databaseEnvironment).toBe("production");
  });
});

describe("production runtime target", () => {
  it("pins the pooled host and needs no Neon API key", () => {
    expect(runtimeTarget(vercel)).toMatchObject({ runtimeEnvironment: "production", productionHost: pooled });
  });
  it("refuses a missing or mismatched pin", () => {
    expect(code(() => runtimeTarget({ ...vercel, DATABASE_PRODUCTION_HOST: undefined }))).toBe("PRODUCTION_PIN_MISSING");
    expect(code(() => runtimeTarget({ ...vercel, DATABASE_PRODUCTION_HOST: "ep-other-pooler.us-east-2.aws.neon.tech" }))).toBe("PRODUCTION_HOST_MISMATCH");
  });
  it("refuses the direct host for the application", () => {
    expect(code(() => runtimeTarget({ ...vercel, DATABASE_URL: directUrl, DATABASE_PRODUCTION_HOST: direct }))).toBe("PRODUCTION_POOLER_REQUIRED");
  });
  it("refuses next start on any machine other than Vercel production", () => {
    expect(code(() => runtimeTarget({ ...vercel, VERCEL: undefined, VERCEL_ENV: undefined }))).toBe("PRODUCTION_CONTEXT_REFUSED");
  });
  it("still rejects a production database for a non-production runtime", () => {
    expect(() => runtimeTarget({ ...vercel, VERCEL_ENV: "preview" })).toThrow("must match");
  });
  it("refuses a loopback production database even when pinned", () => {
    const target: PostgresTarget = {
      connectionString: "postgres://fixture@localhost/app", runtimeEnvironment: "production", databaseEnvironment: "production", productionHost: "localhost",
    };
    expect(code(() => validatePostgresTarget(target))).toBe("PRODUCTION_HOST_MISMATCH");
  });
});

describe("verifyProductionBranch", () => {
  const endpoint = { id: "ep-prod-fixture", host: direct, project_id: project, branch_id: productionBranch, type: "read_write" };
  const branch = { id: productionBranch, project_id: project, name: "main", current_state: "ready" };
  function fake(overrides: Partial<{ branch: typeof branch; endpoints: typeof endpoint[] }> = {}): NeonControlPlane {
    return {
      project: vi.fn(async () => ({ id: project })),
      branch: vi.fn(async () => overrides.branch ?? branch),
      endpoints: vi.fn(async () => overrides.endpoints ?? [endpoint]),
      branches: vi.fn(async () => []),
    };
  }
  const directTarget = () => postgresMigrationTarget(ci);
  const pooledTarget = () => runtimeTarget(vercel);

  it("accepts the direct host and its pooler for the unique read-write endpoint", async () => {
    const plane = fake();
    await verifyProductionBranch(directTarget(), ci, plane);
    await verifyProductionBranch(pooledTarget(), { ...ci, ...vercel }, plane);
    expect(plane.branch).toHaveBeenCalledWith(project, productionBranch);
  });
  it("refuses a branch that is not the pinned production branch", async () => {
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ branch: { ...branch, id: "br-other" } })))).toBe("PRODUCTION_BRANCH_MISMATCH");
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ branch: { ...branch, project_id: "other" } })))).toBe("PRODUCTION_BRANCH_MISMATCH");
  });
  it("refuses a branch that is not ready", async () => {
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ branch: { ...branch, current_state: "init" } })))).toBe("PRODUCTION_BRANCH_NOT_READY");
  });
  it("refuses a host that is not an endpoint of the branch", async () => {
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ endpoints: [{ ...endpoint, id: "ep-other", host: "ep-other.us-east-2.aws.neon.tech" }] })))).toBe("PRODUCTION_ENDPOINT_MISMATCH");
  });
  it("refuses a read-only replica, another branch's endpoint and a duplicate", async () => {
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ endpoints: [{ ...endpoint, type: "read_only" }] })))).toBe("PRODUCTION_ENDPOINT_MISMATCH");
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ endpoints: [{ ...endpoint, branch_id: "br-other" }] })))).toBe("PRODUCTION_ENDPOINT_MISMATCH");
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), ci, fake({ endpoints: [endpoint, endpoint] })))).toBe("PRODUCTION_ENDPOINT_MISMATCH");
  });
  it("requires the pins and rejects names or paths in them", async () => {
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), { ...ci, NEON_PRODUCTION_BRANCH_ID: undefined }, fake()))).toBe("PRODUCTION_NEON_CONFIG_MISSING");
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), { ...ci, NEON_PROJECT_ID: "../x" }, fake()))).toBe("PRODUCTION_NEON_CONFIG_MISSING");
    expect(await codeAsync(() => verifyProductionBranch(directTarget(), { ...ci, NEON_PRODUCTION_BRANCH_ID: "production" }, fake()))).toBe("PRODUCTION_NEON_CONFIG_MISSING");
  });
  it("refuses non-production targets", async () => {
    const dev: PostgresTarget = { connectionString: "postgres://localhost/x", runtimeEnvironment: "development", databaseEnvironment: "development" };
    expect(await codeAsync(() => verifyProductionBranch(dev, ci, fake()))).toBe("PRODUCTION_CONTEXT_REFUSED");
  });
});

describe("openVerifiedPostgres for production", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("opens the runtime pool from the pin alone, without the Neon API", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await openVerifiedPostgres(runtimeTarget(vercel), vercel);
    expect(request).not.toHaveBeenCalled();
    expect(openPostgres).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("refuses a production pool outside CI and Vercel production", async () => {
    expect(await codeAsync(() => openVerifiedPostgres(postgresMigrationTarget(ci), { DATABASE_ENV: "production" }))).toBe("PRODUCTION_CONTEXT_REFUSED");
    expect(openPostgres).not.toHaveBeenCalled();
  });
  it("requires the API key in the CI job and verifies the branch before opening", async () => {
    expect(await codeAsync(() => openVerifiedPostgres(postgresMigrationTarget(ci), { ...ci, NEON_API_KEY: undefined }))).toBe("PRODUCTION_NEON_CONFIG_MISSING");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await codeAsync(() => openVerifiedPostgres(postgresMigrationTarget(ci), ci))).toBe("PRODUCTION_NEON_UNREACHABLE");
    vi.unstubAllGlobals();
    expect(openPostgres).not.toHaveBeenCalled();
  });
});
