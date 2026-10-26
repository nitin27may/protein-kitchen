import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  assertStandardProtection, buildRuntimeManifest, STANDARD_PROTECTION_TYPE, VERCEL_API_ORIGIN, VercelApiError, vercelGet, writeRuntimeManifest,
} from "../lib/deployment/vercel-project";
import { deployedHost, previousProductionDeployment, requireReadyProduction, waitForAlias } from "../lib/deployment/vercel-release";
import { parseRuntimeManifest, checkRuntimeManifest } from "../lib/deployment/check-production";

const part = (...p: string[]) => p.join("");
const token = part("vcp", "_", "fixtureToken", "99");
const secretValue = part("sensitive", "-", "value", "-", "zz");
const env = { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: "prj_abc123", VERCEL_ORG_ID: "team_xyz789" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetcher = (answer: (url: URL, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(async (input, init) => answer(new URL(String(input)), init ?? {}));
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return error instanceof VercelApiError ? error.code : "OTHER"; }
  return "NONE";
};

describe("vercelGet", () => {
  it("talks only to the fixed origin, never follows redirects, and sends the team only for team ids", async () => {
    const request = fetcher(() => json({ ok: 1 }));
    await vercelGet(env, "/v9/projects/prj_abc123", { a: "b" }, { request });
    const [url, init] = request.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe(VERCEL_API_ORIGIN);
    expect(new URL(String(url)).searchParams.get("teamId")).toBe("team_xyz789");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    const personal = fetcher(() => json({}));
    await vercelGet({ ...env, VERCEL_ORG_ID: "user_abc" }, "/x", {}, { request: personal });
    expect(new URL(String(personal.mock.calls[0]![0])).searchParams.has("teamId")).toBe(false);
  });

  it("uses the global fetch when no transport is injected", async () => {
    const stub = fetcher(() => json({ fromGlobal: true }));
    vi.stubGlobal("fetch", stub);
    try { expect(await vercelGet(env, "/x", {})).toEqual({ fromGlobal: true }); } finally { vi.unstubAllGlobals(); }
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("raises value-free errors", async () => {
    for (const [fn, expected] of [
      [() => vercelGet({ ...env, VERCEL_TOKEN: undefined }, "/x", {}), "VERCEL_CONFIG"],
      [() => vercelGet({ ...env, VERCEL_PROJECT_ID: "bad id" }, "/x", {}), "VERCEL_CONFIG"],
      [() => vercelGet({ ...env, VERCEL_PROJECT_ID: undefined }, "/x", {}), "VERCEL_CONFIG"],
      [() => vercelGet({ ...env, VERCEL_ORG_ID: undefined }, "/x", {}), "VERCEL_CONFIG"],
      [() => vercelGet(env, "/x", {}, { request: fetcher(() => { throw new Error(`boom ${token} https://api.vercel.com`); }) }), "VERCEL_UNREACHABLE"],
      [() => vercelGet(env, "/x", {}, { request: fetcher(() => json({ error: token }, 403)) }), "VERCEL_HTTP"],
      [() => vercelGet(env, "/x", {}, { request: fetcher(() => new Response("<html>", { status: 200 })) }), "VERCEL_INVALID"],
    ] as const) {
      let message = "";
      try { await fn(); } catch (error) { message = (error as Error).message; }
      expect(message.startsWith(`${expected}: `), message).toBe(true);
      for (const leak of [token, "api.vercel.com", "prj_abc123", "team_xyz789", "boom"]) expect(message).not.toContain(leak);
    }
  });
});

describe("runtime manifest", () => {
  const listing = {
    envs: [
      { key: "DATABASE_ENV", type: "plain", value: "production", target: ["production"], id: "e1" },
      { key: "DATABASE_URL", type: "sensitive", value: secretValue, target: ["production"] },
      { key: "RESEND_API_KEY", type: "encrypted", value: secretValue, target: "production" },
      { key: "OLD", type: "secret", value: secretValue },
      { key: "EMPTY", type: "plain", target: null },
    ],
    pagination: { count: 5, next: null },
  };

  it("keeps names, types and targets, and a value only for plain variables", async () => {
    const request = fetcher((url) => { expect(url.pathname).toBe("/v10/projects/prj_abc123/env"); expect(url.searchParams.get("decrypt")).toBe("false"); return json(listing); });
    const entries = await buildRuntimeManifest(env, { request });
    expect(entries).toEqual([
      { key: "DATABASE_ENV", type: "plain", target: ["production"], value: "production" },
      { key: "DATABASE_URL", type: "sensitive", target: ["production"] },
      { key: "RESEND_API_KEY", type: "encrypted", target: ["production"] },
      { key: "OLD", type: "secret", target: [] },
      { key: "EMPTY", type: "plain", target: [] },
    ]);
    expect(JSON.stringify(entries)).not.toContain(secretValue);
  });

  it("refuses a partial view and unexpected shapes", async () => {
    expect(await code(buildRuntimeManifest(env, { request: fetcher(() => json({ ...listing, pagination: { next: 1234 } })) }))).toBe("VERCEL_INVALID");
    expect(await code(buildRuntimeManifest(env, { request: fetcher(() => json({ envs: "x" })) }))).toBe("VERCEL_INVALID");
    expect(await code(buildRuntimeManifest(env, { request: fetcher(() => json({ envs: [] })) }))).toBe("NONE");
  });

  it("writes a private file that the production check reads as a value-free manifest", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
    try {
      const file = path.join(dir, "manifest.json");
      const entries = await buildRuntimeManifest(env, { request: fetcher(() => json(listing)) });
      writeRuntimeManifest(file, entries);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).not.toContain(secretValue);
      const manifest = parseRuntimeManifest(JSON.parse(readFileSync(file, "utf8")));
      expect(manifest?.get("DATABASE_ENV")).toEqual({ type: "plain", value: "production" });
      expect(manifest?.get("DATABASE_URL")).toEqual({ type: "sensitive" });
      expect(checkRuntimeManifest(manifest, {}).some((r) => r.severity === "fail")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Deployment Protection assertion", () => {
  const project = (ssoProtection: unknown, id = "prj_abc123") => fetcher(() => json({ id, name: "x", ssoProtection }));
  it("accepts only the named Standard Protection value", async () => {
    expect(STANDARD_PROTECTION_TYPE).toBe("all_except_custom_domains");
    expect(await code(assertStandardProtection(env, { request: project({ deploymentType: STANDARD_PROTECTION_TYPE }) }))).toBe("NONE");
  });

  it("fails closed on all, null, missing, other values, another project and bad shapes", async () => {
    for (const sso of [{ deploymentType: "all" }, { deploymentType: "preview" }, { deploymentType: "prod_deployment_urls_and_all_previews" },
      { deploymentType: null }, { deploymentType: "" }, {}, null, undefined, "all", { deploymentType: 1 }]) {
      expect(await code(assertStandardProtection(env, { request: project(sso) })), JSON.stringify(sso)).toMatch(/VERCEL_PROTECTION_NOT_STANDARD|VERCEL_INVALID/);
    }
    expect(await code(assertStandardProtection(env, { request: project({ deploymentType: STANDARD_PROTECTION_TYPE }, "prj_other") }))).toBe("VERCEL_INVALID");
    expect(await code(assertStandardProtection(env, { request: fetcher(() => json([])) }))).toBe("VERCEL_INVALID");
    expect(await code(assertStandardProtection(env, { request: fetcher(() => json({}, 500)) }))).toBe("VERCEL_HTTP");
  });
});

describe("release helpers", () => {
  it("records the previous production deployment id, or none", async () => {
    const request = fetcher((url) => {
      expect(url.pathname).toBe("/v6/deployments");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ projectId: "prj_abc123", target: "production", state: "READY", limit: "1" });
      return json({ deployments: [{ uid: "dpl_AbC123xyz", url: "x" }] });
    });
    expect(await previousProductionDeployment(env, { request })).toBe("dpl_AbC123xyz");
    expect(await previousProductionDeployment(env, { request: fetcher(() => json({ deployments: [] })) })).toBeUndefined();
    expect(await previousProductionDeployment(env, { request: fetcher(() => json({ deployments: [{ uid: "<script>" }] })) })).toBeUndefined();
    expect(await code(previousProductionDeployment(env, { request: fetcher(() => json({})) }))).toBe("VERCEL_INVALID");
    expect(await previousProductionDeployment({ ...env, VERCEL_PROJECT_ID: "prj_abc123" }, { request: fetcher(() => json({ deployments: [] })) })).toBeUndefined();
    expect(await code(previousProductionDeployment({ ...env, VERCEL_PROJECT_ID: undefined }, { request: fetcher(() => json({})) }))).toBe("VERCEL_CONFIG");
  });

  it("extracts a bare vercel.app host from either deploy output shape", () => {
    expect(deployedHost(JSON.stringify({ url: "protein-kitchen-abc.vercel.app" }))).toBe("protein-kitchen-abc.vercel.app");
    expect(deployedHost(JSON.stringify({ deployment: { url: "https://protein-kitchen-abc.vercel.app/" } }))).toBe("protein-kitchen-abc.vercel.app");
    for (const bad of ["x", "[]", "{}", JSON.stringify({ url: "evil.example.com" }), JSON.stringify({ url: "http://a.vercel.app" }),
      JSON.stringify({ url: "https://u:p@a.vercel.app" }), JSON.stringify({ url: "https://a.vercel.app/path" }), JSON.stringify({ url: "https://a.vercel.app:8443" }),
      JSON.stringify({ url: "https://a.vercel.app/?q=1" }), JSON.stringify({ url: "https://a.vercel.app.evil.com" }), JSON.stringify({ url: "https://" })]) {
      expect(() => deployedHost(bad), bad).toThrow(/VERCEL_INVALID/);
    }
  });

  const deployment = (over: Record<string, unknown> = {}) => ({ id: "dpl_Cand1date9", readyState: "READY", target: "production", alias: [], ...over });
  it("requires the candidate to be READY and a production build", async () => {
    const request = fetcher((url) => { expect(url.pathname).toBe("/v13/deployments/a.vercel.app"); return json(deployment()); });
    expect(await requireReadyProduction(env, "a.vercel.app", { request })).toBe("dpl_Cand1date9");
    expect(await code(requireReadyProduction(env, "a.vercel.app", { request: fetcher(() => json(deployment({ readyState: "BUILDING" }))) }))).toBe("VERCEL_NOT_READY");
    for (const target of ["preview", null, undefined]) {
      expect(await code(requireReadyProduction(env, "a.vercel.app", { request: fetcher(() => json(deployment({ target }))) }))).toBe("VERCEL_WRONG_TARGET");
    }
    expect(await code(requireReadyProduction(env, "a.vercel.app", { request: fetcher(() => json(deployment({ id: "nope" }))) }))).toBe("VERCEL_INVALID");
    expect(await code(requireReadyProduction(env, "a.vercel.app", { request: fetcher(() => json({})) }))).toBe("VERCEL_INVALID");
  });

  it("waits for the production host to become an assigned alias, then times out", async () => {
    let calls = 0;
    const request = fetcher(() => json(deployment(++calls < 3 ? { alias: [] } : { alias: ["app.example.com"], aliasAssigned: 1730000000000 })));
    const sleep = vi.fn(async () => undefined);
    await waitForAlias(env, "dpl_Cand1date9", "https://app.example.com", { request, sleep });
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    let clock = 0;
    const never = fetcher(() => json(deployment({ alias: ["other.example.com"], aliasAssigned: 1 })));
    expect(await code(waitForAlias(env, "dpl_Cand1date9", "https://app.example.com", {
      request: never, sleep: async (ms) => { clock += ms; }, now: () => clock, intervalMs: 10_000, maxWaitMs: 30_000,
    }))).toBe("VERCEL_ALIAS_TIMEOUT");
    expect(await code(waitForAlias(env, "dpl_Cand1date9", "https://app.example.com", {
      request: fetcher(() => json(deployment({ alias: ["app.example.com"] }))), sleep: async () => undefined, now: () => 1e12, maxWaitMs: 0,
    }))).toBe("VERCEL_ALIAS_TIMEOUT");
    expect(await code(waitForAlias(env, "bad", "https://app.example.com"))).toBe("VERCEL_CONFIG");
    expect(await code(waitForAlias(env, "dpl_Cand1date9", "not a url"))).toBe("VERCEL_CONFIG");
    let defaultSleepRuns = 0;
    const quick = fetcher(() => json(++defaultSleepRuns < 2 ? deployment() : deployment({ alias: ["app.example.com"], aliasAssigned: true })));
    await waitForAlias(env, "dpl_Cand1date9", "https://app.example.com", { request: quick, intervalMs: 1 });
    expect(defaultSleepRuns).toBe(2);
  });
});

describe("Vercel scripts", () => {
  const root = path.resolve(__dirname, "..");
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync("pnpm", ["exec", "tsx", `scripts/${script}`, ...args], { cwd: root, encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra } });

  it("refuse without configuration, and with bad usage, before any network request", () => {
    for (const [script, args] of [
      ["vercel-env-manifest.ts", ["out.json"]], ["vercel-env-manifest.ts", []], ["assert-vercel-protection.ts", []],
      ["assert-vercel-protection.ts", ["x"]], ["vercel-release.ts", ["previous"]], ["vercel-release.ts", []], ["vercel-release.ts", ["wait-alias", "dpl_x"]],
    ] as const) {
      const result = run(script, [...args]);
      expect(result.status, `${script} ${args.join(" ")}`).toBe(1);
      expect(result.stdout).toBe("");
    }
    const missingFile = run("vercel-release.ts", ["candidate", "/nonexistent/deploy.json"], { ...env });
    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain("VERCEL_FAILED");
    const dir = mkdtempSync(path.join(tmpdir(), "deploy-"));
    try {
      writeFileSync(path.join(dir, "d.json"), JSON.stringify({ url: "evil.example.com" }));
      expect(run("vercel-release.ts", ["candidate", path.join(dir, "d.json")], { ...env }).stderr).toContain("VERCEL_INVALID");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
