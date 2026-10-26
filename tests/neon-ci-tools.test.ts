import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { neonAdmin, NeonAdminError } from "../lib/deployment/neon-admin";
import { compareHumanCounts, HUMAN_OWNED_TABLES, parseCounts, readHumanCounts } from "../lib/deployment/human-counts";
import type { CountQueryable } from "../lib/deployment/human-counts";
import { readOnlyGuard } from "../lib/deployment/check-production";
import {
  createPreDeploySnapshot, DEFAULT_RETENTION_DAYS, retentionDays, SNAPSHOT_KEEP, snapshotName,
} from "../lib/deployment/neon-snapshot";
import {
  createRehearsalBranch, deleteRehearsalBranch, rehearsalName, requireRehearsalBranch, requireRehearsalCi,
} from "../lib/deployment/rehearsal-branch";
import type { RehearsalOutput } from "../lib/deployment/rehearsal-branch";

const part = (...pieces: string[]) => pieces.join("");
const apiKey = part("napi", "_", "fixture", "Key", "424242");
const password = part("pw", "-", "Zk39Hq", "-", "fixture");
const project = "synthetic-project-123";
const productionId = "br-synthetic-production";
const sha = "0123456789abcdef0123456789abcdef01234567";
const now = new Date("2026-10-25T12:34:56.789Z");

const direct = "ep-rehearse-fixture.us-east-2.aws.neon.tech";
const pooled = "ep-rehearse-fixture-pooler.us-east-2.aws.neon.tech";
function uri(host: string): string {
  const url = new URL(`postgres://${host}/app`);
  url.username = "fixture";
  url.password = password;
  return url.toString();
}

interface Branch { id: string; name: string; created_at: string; protected?: boolean; parent_id?: string; expires_at?: string; endpoints?: unknown }
/** In-memory Neon. Every request goes through the real admin client; nothing leaves the process. */
function fakeNeon(initial: Branch[] = [], options: { limit?: number; uris?: Record<string, string> } = {}) {
  const branches: Branch[] = [{ id: productionId, name: "production", created_at: "2026-01-01T00:00:00Z", protected: true }, ...initial];
  const requests: { method: string; path: string; body: unknown }[] = [];
  let next = 1;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const view = (b: Branch) => ({ id: b.id, name: b.name, project_id: project, current_state: "ready", created_at: b.created_at, parent_id: b.parent_id ?? null, protected: b.protected ?? false, default: b.id === productionId, primary: b.id === productionId });
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/api/v2/projects/${project}`, "") + url.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (url.origin !== "https://console.neon.tech") throw new Error("unexpected origin");
    if (method === "POST" && path === "/branches") {
      if (options.limit !== undefined && branches.length >= options.limit) return reply({ code: "BRANCHES_LIMIT_EXCEEDED", message: "limit" }, 422);
      const created: Branch = { id: `br-new-${next++}`, name: body.branch.name, created_at: now.toISOString(), parent_id: body.branch.parent_id, expires_at: body.branch.expires_at, endpoints: body.endpoints };
      branches.push(created);
      return reply({ branch: view(created), operations: [{ id: "op-1", status: "finished" }] }, 201);
    }
    if (method === "GET" && path === "/branches") return reply({ branches: branches.map(view) });
    if (method === "GET" && path.startsWith("/branches/")) {
      const found = branches.find((b) => b.id === path.split("/")[2]);
      return found ? reply({ branch: view(found) }) : reply({}, 404);
    }
    if (method === "DELETE") {
      const index = branches.findIndex((b) => b.id === path.split("/")[2]);
      if (index < 0) return reply({}, 404);
      branches.splice(index, 1);
      return reply({ operations: [{ id: "op-2", status: "finished" }] });
    }
    if (method === "GET" && path.startsWith("/connection_uri")) {
      const pooledFlag = url.searchParams.get("pooled") === "true";
      return reply({ uri: options.uris?.[String(pooledFlag)] ?? uri(pooledFlag ? pooled : direct) });
    }
    return reply({}, 500);
  });
  const admin = neonAdmin(apiKey, { request, sleep: async () => undefined, now: () => 0 });
  return { admin, branches, requests, names: () => branches.map((b) => b.name) };
}

const productionEnv = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", DEPLOYMENT_ENVIRONMENT: "production", GITHUB_SHA: sha,
  NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: productionId, NEON_API_KEY: apiKey,
};
const snapshotAt = (day: number) => ({
  id: `br-old-${day}`, name: `pre-deploy-202610${String(day).padStart(2, "0")}T120000Z-abcdef${day % 10}`, created_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
});

describe("pre-deploy snapshot", () => {
  it("names the branch from the UTC timestamp and the short commit", () => {
    expect(snapshotName(now, sha)).toBe("pre-deploy-20261025T123456Z-0123456");
    expect(() => snapshotName(now, "abc")).toThrow("GITHUB_SHA");
    expect(() => snapshotName(now, undefined)).toThrow("GITHUB_SHA");
  });

  it("reads the retention with a default and strict bounds", () => {
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(retentionDays({ SNAPSHOT_RETENTION_DAYS: " " })).toBe(7);
    expect(retentionDays({ SNAPSHOT_RETENTION_DAYS: "14" })).toBe(14);
    for (const bad of ["0", "31", "1.5", "-2", "abc"]) expect(() => retentionDays({ SNAPSHOT_RETENTION_DAYS: bad })).toThrow("SNAPSHOT_RETENTION_DAYS");
  });

  it("creates a compute-less child of production that expires, and prunes beyond the newest five", async () => {
    const fx = fakeNeon([1, 2, 3, 4, 5, 6, 7].map(snapshotAt));
    const result = await createPreDeploySnapshot({ ...productionEnv, SNAPSHOT_RETENTION_DAYS: "3" }, fx.admin, now);
    expect(result).toEqual({ name: "pre-deploy-20261025T123456Z-0123456", id: "br-new-1" });
    const create = fx.requests.find((r) => r.method === "POST")!;
    expect(create.body).toEqual({ branch: { parent_id: productionId, name: result.name, expires_at: "2026-10-28T12:34:56.789Z" } });
    expect(create.body).not.toHaveProperty("endpoints");
    const snapshots = fx.names().filter((n) => n.startsWith("pre-deploy-"));
    expect(snapshots).toHaveLength(SNAPSHOT_KEEP);
    expect(snapshots).toContain(result.name);
    expect(fx.names()).toContain("production");
    expect(SNAPSHOT_KEEP).toBe(5);
  });

  it("is refused outside the approved production CI job, before any request", async () => {
    for (const env of [
      { ...productionEnv, GITHUB_ACTIONS: undefined }, { ...productionEnv, GITHUB_REF: "refs/heads/feature" },
      { ...productionEnv, DEPLOYMENT_ENVIRONMENT: "rehearsal" }, { ...productionEnv, VERCEL: "1" },
    ]) {
      const fx = fakeNeon();
      await expect(createPreDeploySnapshot(env, fx.admin, now)).rejects.toThrow("PRODUCTION_CONTEXT_REFUSED");
      expect(fx.requests).toHaveLength(0);
    }
  });

  it("refuses unpinned production and bad retention before any request", async () => {
    const fx = fakeNeon();
    await expect(createPreDeploySnapshot({ ...productionEnv, NEON_PRODUCTION_BRANCH_ID: undefined }, fx.admin, now)).rejects.toThrow("PRODUCTION_NEON_CONFIG_MISSING");
    await expect(createPreDeploySnapshot({ ...productionEnv, SNAPSHOT_RETENTION_DAYS: "0" }, fx.admin, now)).rejects.toThrow("SNAPSHOT_RETENTION_DAYS");
    await expect(createPreDeploySnapshot({ ...productionEnv, GITHUB_SHA: "short" }, fx.admin, now)).rejects.toThrow("GITHUB_SHA");
    expect(fx.requests).toHaveLength(0);
  });

  it("stops with a clear, value-free message when the free-plan branch limit is hit", async () => {
    const fx = fakeNeon([1, 2].map(snapshotAt), { limit: 3 });
    const error = await createPreDeploySnapshot(productionEnv, fx.admin, now).then(() => undefined, (e: unknown) => e as NeonAdminError) as NeonAdminError;
    expect(error).toMatchObject({ code: "NEON_ADMIN_LIMIT" });
    expect(error.message).toContain("plan limit");
    for (const value of [apiKey, project, productionId, sha, password]) expect(error.message).not.toContain(value);
    expect(fx.names().filter((n) => n.startsWith("pre-deploy-"))).toHaveLength(2);
  });

  it("fails the run when a prune delete fails", async () => {
    const fx = fakeNeon([1, 2, 3, 4, 5, 6].map(snapshotAt));
    const original = fx.admin.deleteBranch;
    fx.admin.deleteBranch = async () => { throw new NeonAdminError("NEON_ADMIN_HTTP", "x"); };
    await expect(createPreDeploySnapshot(productionEnv, fx.admin, now)).rejects.toThrow("NEON_ADMIN_PRUNE_FAILED");
    fx.admin.deleteBranch = original;
  });
});

function capture() {
  const logs: string[] = [], env: string[] = [];
  const out: RehearsalOutput = { log: (l) => logs.push(l), appendEnv: (l) => env.push(l) };
  return { out, logs, env };
}
const ciEnv = {
  GITHUB_ACTIONS: "true", GITHUB_SHA: sha, GITHUB_RUN_ID: "424242", NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: productionId,
  NEON_API_KEY: apiKey, NEON_DATABASE_NAME: "app", NEON_ROLE_NAME: "fixture",
};

describe("rehearsal branch", () => {
  it("names the branch from the commit and run", () => {
    expect(rehearsalName(sha, "77")).toBe("rehearse-0123456-77");
    expect(() => rehearsalName(undefined, "77")).toThrow("GITHUB_SHA");
    expect(() => rehearsalName("zz", "77")).toThrow("GITHUB_SHA");
    expect(() => rehearsalName(sha, undefined)).toThrow("GITHUB_RUN_ID");
    expect(() => rehearsalName(sha, "run-1")).toThrow("GITHUB_RUN_ID");
  });

  it("creates a read-write child of production for 24 hours, masks every secret first and exports only the three variables", async () => {
    const fx = fakeNeon();
    const { out, logs, env } = capture();
    const result = await createRehearsalBranch(ciEnv, fx.admin, out, now);
    expect(result).toEqual({ name: "rehearse-0123456-424242", id: "br-new-1" });
    const create = fx.requests.find((r) => r.method === "POST")!;
    expect(create.body).toEqual({
      branch: { parent_id: productionId, name: "rehearse-0123456-424242", expires_at: "2026-10-26T12:34:56.789Z" },
      endpoints: [{ type: "read_write" }],
    });
    const uris = fx.requests.filter((r) => r.path.startsWith("/connection_uri")).map((r) => r.path);
    expect(uris).toEqual([
      "/connection_uri?branch_id=br-new-1&database_name=app&role_name=fixture&pooled=true",
      "/connection_uri?branch_id=br-new-1&database_name=app&role_name=fixture&pooled=false",
    ]);
    expect(logs).toContain(`::add-mask::${uri(pooled)}`);
    expect(logs).toContain(`::add-mask::${uri(direct)}`);
    expect(logs).toContain(`::add-mask::${password}`);
    expect(logs.every((l) => l.startsWith("::add-mask::"))).toBe(true);
    expect(env).toEqual([
      `DATABASE_URL_UNPOOLED=${uri(direct)}`, `DATABASE_NONPRODUCTION_HOST=${direct}`, "NEON_DEVELOPMENT_BRANCH_ID=br-new-1",
    ]);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("skips masking an empty password", async () => {
    const fx = fakeNeon([], { uris: { true: `postgres://${pooled}/app`, false: `postgres://${direct}/app` } });
    const { out, logs } = capture();
    await createRehearsalBranch(ciEnv, fx.admin, out, now);
    expect(logs).toEqual([`::add-mask::postgres://${pooled}/app`, `::add-mask::postgres://${direct}/app`]);
  });

  it("is refused outside GitHub Actions and without database or role names", async () => {
    const fx = fakeNeon();
    const { out } = capture();
    await expect(createRehearsalBranch({ ...ciEnv, GITHUB_ACTIONS: undefined }, fx.admin, out, now)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
    await expect(createRehearsalBranch({ ...ciEnv, NEON_ROLE_NAME: undefined }, fx.admin, out, now)).rejects.toThrow("NEON_ADMIN_CONFIG");
    await expect(createRehearsalBranch({ ...ciEnv, NEON_DATABASE_NAME: undefined }, fx.admin, out, now)).rejects.toThrow("NEON_ADMIN_CONFIG");
    expect(fx.requests).toHaveLength(0);
    expect(() => requireRehearsalCi({ GITHUB_ACTIONS: "false" })).toThrow("NEON_ADMIN_REFUSED_TARGET");
  });

  it("rejects connection URIs that are malformed or do not belong to one endpoint, after masking", async () => {
    const cases: Record<string, string>[] = [
      { true: "not a url", false: uri(direct) },
      { true: uri(pooled), false: "not a url" },
      { true: uri(direct), false: uri(direct) },
      { true: uri(pooled), false: uri(pooled) },
      { true: uri("ep-other-pooler.us-east-2.aws.neon.tech"), false: uri(direct) },
      { true: uri("ep-rehearse-fixture-pooler.example.test"), false: uri("ep-rehearse-fixture.example.test") },
    ];
    for (const uris of cases) {
      const fx = fakeNeon([], { uris });
      const { out, env } = capture();
      await expect(createRehearsalBranch(ciEnv, fx.admin, out, now)).rejects.toThrow("NEON_ADMIN_INVALID");
      expect(env).toEqual([]);
    }
  });

  it("surfaces the branch limit without leaking values", async () => {
    const fx = fakeNeon([], { limit: 1 });
    const { out, logs } = capture();
    const error = await createRehearsalBranch(ciEnv, fx.admin, out, now).then(() => new Error("resolved"), (e: unknown) => e as Error);
    expect(error.message).toContain("NEON_ADMIN_LIMIT");
    expect(logs).toEqual([]);
  });

  it("requires the target to be a rehearse- branch that is not production", async () => {
    const fx = fakeNeon([{ id: "br-reh", name: "rehearse-0123456-1", created_at: now.toISOString() }, { id: "br-dev", name: "dev-step14-rehearsal", created_at: now.toISOString() }, { id: "br-prot", name: "rehearse-protected", created_at: now.toISOString(), protected: true }]);
    expect(await requireRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: "br-reh" }, fx.admin)).toEqual({ name: "rehearse-0123456-1", id: "br-reh" });
    for (const id of [productionId, "br-dev", "br-prot", undefined]) {
      await expect(requireRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: id }, fx.admin)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
    }
    await expect(requireRehearsalBranch({ ...ciEnv, GITHUB_ACTIONS: undefined, NEON_DEVELOPMENT_BRANCH_ID: "br-reh" }, fx.admin)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
  });

  it("deletes only a rehearse- branch and treats an already-gone branch as done", async () => {
    const fx = fakeNeon([{ id: "br-reh", name: "rehearse-0123456-1", created_at: now.toISOString() }, snapshotAt(1)]);
    expect(await deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: "br-reh" }, fx.admin)).toBe("deleted");
    expect(fx.names()).not.toContain("rehearse-0123456-1");
    expect(await deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: "br-reh" }, fx.admin)).toBe("absent");

    const before = fx.requests.length;
    for (const id of [productionId, undefined]) {
      await expect(deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: id }, fx.admin)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
    }
    // A snapshot branch is not a valid rehearsal target, so the client refuses and nothing is deleted.
    await expect(deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: "br-old-1" }, fx.admin)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
    await expect(deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: productionId, GITHUB_ACTIONS: undefined }, fx.admin)).rejects.toThrow("NEON_ADMIN_REFUSED_TARGET");
    expect(fx.requests.slice(before).filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(fx.names()).toContain("production");
  });

  it("rethrows any other delete failure", async () => {
    const fx = fakeNeon();
    fx.admin.deleteBranch = async () => { throw new NeonAdminError("NEON_ADMIN_HTTP", "x"); };
    await expect(deleteRehearsalBranch({ ...ciEnv, NEON_DEVELOPMENT_BRANCH_ID: "br-reh" }, fx.admin)).rejects.toThrow("NEON_ADMIN_HTTP");
  });
});

describe("human-owned row counts", () => {
  function database(rows: Record<string, number | null>) {
    const statements: string[] = [];
    const client: CountQueryable = {
      async query(text) {
        statements.push(text);
        const table = /public\.([a-z_]+)/.exec(text)?.[1];
        if (text.includes("to_regclass")) return { rows: [{ present: rows[table!] !== null && rows[table!] !== undefined }] };
        if (text.includes("count(*)")) return { rows: [{ n: String(rows[table!]) }] };
        return { rows: [] };
      },
    };
    return { client, statements };
  }

  it("reads counts only, in a read-only transaction that passes the read-only guard", async () => {
    const { client, statements } = database({ plans: 3, photos: 0, pantry: null });
    const counts = await readHumanCounts(readOnlyGuard(client), ["plans", "photos", "pantry"]);
    expect(counts).toEqual({ plans: 3, photos: 0, pantry: null });
    expect(statements[0]).toBe("begin read only");
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.filter((s) => s.includes("count(*)"))).toEqual(["select count(*)::text as n from public.plans", "select count(*)::text as n from public.photos"]);
    for (const statement of statements.filter((s) => s.startsWith("select"))) expect(statement).not.toMatch(/select\s+\*|,\s*[a-z_]+\s+from/i);
  });

  it("covers every human-owned table by default and rolls back on a bad count", async () => {
    const all = Object.fromEntries(HUMAN_OWNED_TABLES.map((t) => [t, 1]));
    const { client } = database(all);
    expect(Object.keys(await readHumanCounts(client))).toEqual([...HUMAN_OWNED_TABLES]);
    const bad = database({ plans: -1 });
    await expect(readHumanCounts(bad.client, ["plans"])).rejects.toThrow("COUNTS_INVALID");
    expect(bad.statements.at(-1)).toBe("rollback");
    const odd: CountQueryable = { query: async (t) => ({ rows: t.includes("to_regclass") ? [{ present: true }] : [] }) };
    await expect(readHumanCounts(odd, ["plans"])).rejects.toThrow("COUNTS_INVALID");
    const none: CountQueryable = { query: async () => ({ rows: [] }) };
    expect(await readHumanCounts(none, ["plans"])).toEqual({ plans: null });
  });

  it("fails the comparison when any table lost rows or disappeared, and allows growth and new tables", () => {
    expect(compareHumanCounts({ a: 2, b: 0, c: null }, { a: 2, b: 5, c: 1, d: 9 })).toEqual({ ok: true, lost: [], dropped: [] });
    expect(compareHumanCounts({ a: 2, b: 3 }, { a: 1, b: 3 })).toEqual({ ok: false, lost: ["a"], dropped: [] });
    expect(compareHumanCounts({ a: 2, b: 3 }, { a: 2 })).toEqual({ ok: false, lost: [], dropped: ["b"] });
    expect(compareHumanCounts({ a: 2 }, { a: null })).toEqual({ ok: false, lost: [], dropped: ["a"] });
  });

  it("parses a counts file strictly", () => {
    expect(parseCounts({ plans: 2, pantry: null })).toEqual({ plans: 2, pantry: null });
    for (const bad of [null, [], "x", { plans: -1 }, { plans: "2" }, { "Plans;drop": 1 }, { plans: 1.5 }]) {
      expect(() => parseCounts(bad)).toThrow("COUNTS_INVALID");
    }
  });
});

describe("scripts", () => {
  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync("pnpm", ["exec", "tsx", script, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 100_000 });

  it("refuse to run outside CI before contacting anything", () => {
    const snapshot = run("scripts/neon-snapshot.ts", [], { NEON_API_KEY: apiKey, NEON_PROJECT_ID: project, NEON_PRODUCTION_BRANCH_ID: productionId });
    expect(snapshot.status).toBe(1);
    expect(snapshot.stderr).toContain("PRODUCTION_CONTEXT_REFUSED");
    for (const command of ["create", "delete", "counts"]) {
      const result = run("scripts/rehearsal-branch.ts", command === "counts" ? [command, "out.json"] : [command], { NEON_API_KEY: apiKey });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("NEON_ADMIN_REFUSED_TARGET");
      expect(result.stdout + result.stderr).not.toContain(apiKey);
    }
  }, 120_000);

  it("compare fails on lost rows and passes otherwise; usage errors are plain", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "counts-"));
    writeFileSync(join(dir, "before.json"), JSON.stringify({ plans: 3, photos: 1 }));
    writeFileSync(join(dir, "same.json"), JSON.stringify({ plans: 3, photos: 4 }));
    writeFileSync(join(dir, "lost.json"), JSON.stringify({ plans: 2, photos: 4 }));
    const env = { GITHUB_ACTIONS: "true" };
    const ok = run("scripts/rehearsal-branch.ts", ["compare", join(dir, "before.json"), join(dir, "same.json")], env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("counts ok");
    const lost = run("scripts/rehearsal-branch.ts", ["compare", join(dir, "before.json"), join(dir, "lost.json")], env);
    expect(lost.status).toBe(1);
    expect(lost.stderr).toContain("COUNTS_LOST tables=plans");
    const usage = run("scripts/rehearsal-branch.ts", ["frobnicate"], env);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain("Usage:");
  }, 120_000);
});
