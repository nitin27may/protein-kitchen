import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyNonProductionBranch } from "../lib/db/postgres/verify-branch";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { openPostgres } from "../lib/db/postgres/client";
import { openDb } from "../lib/db/client";
import type { PostgresTarget } from "../lib/db/postgres/target";

vi.mock("../lib/db/postgres/client", () => ({ openPostgres: vi.fn() }));

const project = "synthetic-project-123";
const development = "br-synthetic-development";
const production = "br-synthetic-production";
const host = "ep-synthetic.us-east-2.aws.neon.tech";
const environment = {
  NEON_PROJECT_ID: project, NEON_DEVELOPMENT_BRANCH_ID: development,
  NEON_PRODUCTION_BRANCH_ID: production, NEON_API_KEY: "synthetic-control-plane-key",
};
const target: PostgresTarget = {
  connectionString: `postgres://fixture@${host}/fixture?sslmode=verify-full`,
  nonProductionHost: host, runtimeEnvironment: "development", databaseEnvironment: "development",
};
const branch = () => ({
  branch: { id: development, project_id: project, name: "dev", default: false, primary: false, protected: false, current_state: "ready" },
});
const endpoint = () => ({ id: "ep-synthetic", host, project_id: project, branch_id: development, type: "read_write" });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(response(branch())).mockResolvedValueOnce(response({ endpoints: [endpoint()] }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("live Neon branch-to-host verification", () => {
  it("reads authoritative project-scoped metadata without opening a database or sending secrets in a URL", async () => {
    await verifyNonProductionBranch(target, environment, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://console.neon.tech/api/v2/projects/${project}/branches/${development}`,
      `https://console.neon.tech/api/v2/projects/${project}/branches/${development}/endpoints`,
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${environment.NEON_API_KEY}` }, redirect: "error", cache: "no-store" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(openPostgres).not.toHaveBeenCalled();
  });

  it.each(["development", "test", "preview"] as const)("verifies %s traffic against the same branch mapping", async (runtime) => {
    await verifyNonProductionBranch({ ...target, runtimeEnvironment: runtime, databaseEnvironment: runtime }, environment, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts the pooler derived from the authoritative direct endpoint, not an arbitrary suffix", async () => {
    const pooled = host.replace("ep-synthetic.", "ep-synthetic-pooler.");
    await verifyNonProductionBranch({
      ...target, nonProductionHost: pooled, connectionString: `postgres://fixture@${pooled}/fixture`,
    }, environment, fetchMock);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("keeps synthetic loopback %s independent of cloud credentials", async (local) => {
    await verifyNonProductionBranch({ ...target, connectionString: `postgres://fixture@${local}/fixture` }, {}, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the production runtime outside this development gate, without a control-plane dependency", async () => {
    await verifyNonProductionBranch({ ...target, runtimeEnvironment: "production", databaseEnvironment: "production" }, {}, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["NEON_PROJECT_ID", "NEON_DEVELOPMENT_BRANCH_ID", "NEON_PRODUCTION_BRANCH_ID", "NEON_API_KEY"])("requires %s for remote development", async (key) => {
    await expect(verifyNonProductionBranch(target, { ...environment, [key]: undefined }, fetchMock)).rejects.toThrow("requires NEON_PROJECT_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { NEON_PROJECT_ID: "../other" }, { NEON_DEVELOPMENT_BRANCH_ID: "dev" },
    { NEON_PRODUCTION_BRANCH_ID: "production" }, { NEON_DEVELOPMENT_BRANCH_ID: "br-other?project=elsewhere" },
  ])("rejects names and path/query injection in branch selection (%#)", async (changes) => {
    await expect(verifyNonProductionBranch(target, { ...environment, ...changes }, fetchMock)).rejects.toThrow("explicit project and branch ids");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a production branch id relabelled development before any network request", async () => {
    await expect(verifyNonProductionBranch(target, { ...environment, NEON_DEVELOPMENT_BRANCH_ID: production }, fetchMock)).rejects.toThrow("production branch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "production" }, { name: "Prod" }, { name: " main " }, { name: "master" },
    { default: true }, { primary: true }, { protected: true }, { current_state: "deleting" },
    { id: production }, { project_id: "different-project" },
  ])("refuses unsafe authoritative branch metadata (%#)", async (changes) => {
    fetchMock.mockReset().mockResolvedValue(response({ branch: { ...branch().branch, ...changes } }));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("never production");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { branch: { ...branch().branch, default: undefined } },
    { branch: { ...branch().branch, primary: "false" } },
    { branch: { ...branch().branch, name: "" } },
  ])("fails closed on incomplete or incorrectly typed branch metadata (%#)", async (body) => {
    fetchMock.mockReset().mockResolvedValue(response(body));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("incomplete branch metadata");
  });

  it.each<{ endpoints: unknown }>([
    { endpoints: [] }, { endpoints: [{ ...endpoint(), host: "ep-other.us-east-2.aws.neon.tech" }] },
    { endpoints: [{ ...endpoint(), project_id: "other-project" }] }, { endpoints: [{ ...endpoint(), branch_id: production }] },
    { endpoints: [{ ...endpoint(), type: "read_only" }] }, { endpoints: [{ ...endpoint(), id: "ep-different" }] },
    { endpoints: [endpoint(), endpoint()] },
  ])("refuses unknown, foreign, ambiguous and read-only endpoints (%#)", async ({ endpoints }) => {
    fetchMock.mockReset().mockResolvedValueOnce(response(branch())).mockResolvedValueOnce(response({ endpoints }));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("not a unique read-write endpoint");
  });

  it.each([{}, { endpoints: null }, { endpoints: [{ host }] }])("fails closed on malformed endpoint lists (%#)", async (body) => {
    fetchMock.mockReset().mockResolvedValueOnce(response(branch())).mockResolvedValueOnce(response(body));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("incomplete endpoint metadata");
  });

  it.each([401, 403, 404, 429, 500])("surfaces HTTP %s without leaking response bodies or keys", async (status) => {
    fetchMock.mockReset().mockResolvedValue(new Response("private upstream detail", { status }));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow(`HTTP ${status}`);
    try { await verifyNonProductionBranch(target, environment, fetchMock); } catch (error) {
      expect(String(error)).not.toContain("private upstream detail");
      expect(String(error)).not.toContain(environment.NEON_API_KEY);
    }
  });

  it("rejects network/timeout errors without echoing unsafe upstream details", async () => {
    fetchMock.mockReset().mockRejectedValue(new Error(`upstream secret ${environment.NEON_API_KEY}`));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("could not reach the control plane");
  });

  it("rejects malformed JSON", async () => {
    fetchMock.mockReset().mockResolvedValue(new Response("not JSON"));
    await expect(verifyNonProductionBranch(target, environment, fetchMock)).rejects.toThrow("invalid JSON");
  });

  it.each(["unverified.example.com", "ep-synthetic.neon.tech.attacker.invalid"])("refuses non-Neon host %s without transmitting an API key", async (hostname) => {
    await expect(verifyNonProductionBranch({ ...target, nonProductionHost: hostname, connectionString: `postgres://fixture@${hostname}/fixture` }, environment, fetchMock)).rejects.toThrow("verified Neon endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses alternate network ports even when the host is allowed", async () => {
    await expect(verifyNonProductionBranch({ ...target, connectionString: `postgres://fixture@${host}:6543/fixture` }, environment, fetchMock)).rejects.toThrow("port 5432");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still applies existing target validation before metadata requests", async () => {
    await expect(verifyNonProductionBranch({ ...target, databaseEnvironment: "production" }, environment, fetchMock)).rejects.toThrow("must match");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verified pool boundary", () => {
  it("does not construct a pool on verification failure and retries successfully rather than caching failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(openVerifiedPostgres(target, environment)).rejects.toThrow("could not reach");
    expect(openPostgres).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", fetchMock);
    await openVerifiedPostgres(target, environment);
    expect(openPostgres).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("application openDb awaits the same verification rather than directly opening the pool", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_ENV", "development");
    vi.stubEnv("DATABASE_URL", target.connectionString);
    vi.stubEnv("DATABASE_NONPRODUCTION_HOST", host);
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(openDb()).rejects.toThrow("could not reach");
    expect(openPostgres).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", fetchMock);
    await openDb();
    expect(openPostgres).toHaveBeenCalledTimes(1);
  });
});
