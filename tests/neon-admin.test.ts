import { afterEach, describe, expect, it, vi } from "vitest";
import { neonAdmin, neonAdminFromEnv, NeonAdminError } from "../lib/deployment/neon-admin";
import type { NeonAdmin } from "../lib/deployment/neon-admin";

// Built at runtime so no key-shaped literal sits in the source.
const apiKey = ["napi", "_", "fixture", "Key", "424242"].join("");
const project = "synthetic-project-123";
const parent = "br-synthetic-production";
const base = `https://console.neon.tech/api/v2/projects/${project}`;

interface Call { method: string; url: string; body: unknown; init: RequestInit }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const branchBody = (over: Record<string, unknown> = {}) => ({
  id: "br-new-1", project_id: project, name: "pre-deploy-20261025T120000Z-abcdef1", current_state: "ready",
  created_at: "2026-10-25T12:00:00Z", ...over,
});

/** A scripted control plane. Every request is recorded; nothing leaves the process. */
function fake(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const call: Call = { method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return { calls, request };
}
function adminWith(handler: (call: Call) => Response | Promise<Response>, extra: Parameters<typeof neonAdmin>[1] = {}) {
  const f = fake(handler);
  let clock = 0;
  const admin = neonAdmin(apiKey, {
    request: f.request, sleep: async (ms) => { clock += ms; }, now: () => clock, pollIntervalMs: 1_000, maxWaitMs: 5_000, ...extra,
  });
  return { ...f, admin };
}
const create = { parent_id: parent, name: "pre-deploy-20261025T120000Z-abcdef1", expires_at: "2026-11-01T12:00:00.000Z" };
const code = async (promise: Promise<unknown>) => promise.then(() => "resolved", (e: unknown) => (e instanceof NeonAdminError ? e.code : "OTHER"));
const message = async (promise: Promise<unknown>) => promise.then(() => "", (e: unknown) => (e as Error).message);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("request hygiene", () => {
  it("uses the fixed origin, bearer auth, no redirects and a timeout; the key never reaches a URL or body", async () => {
    const { admin, calls } = adminWith(() => json({ branches: [] }));
    await admin.listBranches(project);
    expect(calls[0]!.url).toBe(`${base}/branches`);
    expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${apiKey}`);
    expect(calls[0]!.url + JSON.stringify(calls[0]!.body ?? "")).not.toContain(apiKey);
  });

  it("reads the key only from NEON_API_KEY", async () => {
    expect(() => neonAdminFromEnv({})).toThrow("NEON_ADMIN_CONFIG");
    const f = fake(() => json({ branches: [] }));
    await neonAdminFromEnv({ NEON_API_KEY: apiKey }, { request: f.request }).listBranches(project);
    expect(f.calls).toHaveLength(1);
  });

  it("maps failures to value-free errors", async () => {
    const secretBody = "internal-detail-do-not-print";
    const down = adminWith(() => { throw new Error(`socket ${apiKey}`); });
    expect(await code(down.admin.listBranches(project))).toBe("NEON_ADMIN_UNREACHABLE");
    expect(await message(down.admin.listBranches(project))).not.toContain(apiKey);

    const server = adminWith(() => new Response(secretBody, { status: 500 }));
    expect(await message(server.admin.listBranches(project))).toBe("NEON_ADMIN_HTTP: The Neon control plane answered HTTP 500.");

    const missing = adminWith(() => new Response(secretBody, { status: 404 }));
    expect(await code(missing.admin.listBranches(project))).toBe("NEON_ADMIN_NOT_FOUND");

    const badJson = adminWith(() => new Response("not json", { status: 200 }));
    expect(await code(badJson.admin.listBranches(project))).toBe("NEON_ADMIN_INVALID");

    const incomplete = adminWith(() => json({ branches: [{ id: 1 }] }));
    expect(await code(incomplete.admin.listBranches(project))).toBe("NEON_ADMIN_INVALID");
  });

  it("rejects malformed project and branch ids before any request", async () => {
    const { admin, calls } = adminWith(() => json({}));
    expect(await code(admin.listBranches("../x"))).toBe("NEON_ADMIN_CONFIG");
    expect(await code(admin.getBranch(project, "main"))).toBe("NEON_ADMIN_CONFIG");
    expect(calls).toHaveLength(0);
  });
});

describe("createBranch", () => {
  const created = (over: Record<string, unknown> = {}) => json({ branch: branchBody(over), operations: [{ id: "op-1", status: "finished" }] }, 201);

  it("creates a snapshot branch with no endpoint and returns the ready branch", async () => {
    const { admin, calls } = adminWith((c) => c.method === "POST" ? created() : json({ branch: branchBody() }));
    const branch = await admin.createBranch(project, create);
    expect(branch).toMatchObject({ id: "br-new-1", current_state: "ready" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ branch: { parent_id: parent, name: create.name, expires_at: create.expires_at } });
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends a read-write endpoint when asked and tolerates a response without operations", async () => {
    const { admin, calls } = adminWith((c) => c.method === "POST" ? json({ branch: branchBody({ name: "rehearse-abc1234-9" }) }) : json({ branch: branchBody({ name: "rehearse-abc1234-9" }) }));
    await admin.createBranch(project, { ...create, name: "rehearse-abc1234-9", endpoints: [{ type: "read_write" }] });
    expect((calls[0]!.body as { endpoints: unknown }).endpoints).toEqual([{ type: "read_write" }]);
    await admin.createBranch(project, { ...create, name: "rehearse-abc1234-9", endpoints: [] });
    expect(calls[2]!.body).not.toHaveProperty("endpoints");
  });

  it("waits for a running operation and a branch that is not ready yet", async () => {
    let polls = 0, reads = 0;
    const { admin, calls } = adminWith((c) => {
      if (c.method === "POST") return json({ branch: branchBody({ current_state: "init" }), operations: [{ id: "op-1", status: "running" }] });
      if (c.url.includes("/operations/")) return json({ operation: { id: "op-1", status: ++polls < 2 ? "running" : "finished" } });
      return json({ branch: branchBody({ current_state: ++reads < 2 ? "init" : "ready" }) });
    });
    expect((await admin.createBranch(project, create)).current_state).toBe("ready");
    expect(calls.filter((c) => c.url.includes("/operations/"))).toHaveLength(2);
    expect(reads).toBe(2);
  });

  it("fails when an operation fails or never finishes", async () => {
    const failed = adminWith(() => json({ branch: branchBody(), operations: [{ id: "op-1", status: "failed" }] }));
    expect(await code(failed.admin.createBranch(project, create))).toBe("NEON_ADMIN_OPERATION_FAILED");

    const failsLater = adminWith((c) => c.method === "POST"
      ? json({ branch: branchBody(), operations: [{ id: "op-1", status: "running" }] })
      : json({ operation: { id: "op-1", status: "error" } }));
    expect(await code(failsLater.admin.createBranch(project, create))).toBe("NEON_ADMIN_OPERATION_FAILED");

    const stuck = adminWith((c) => c.method === "POST"
      ? json({ branch: branchBody(), operations: [{ id: "op-1", status: "running" }] })
      : json({ operation: { id: "op-1", status: "running" } }));
    expect(await code(stuck.admin.createBranch(project, create))).toBe("NEON_ADMIN_TIMEOUT");

    const neverReady = adminWith((c) => c.method === "POST"
      ? json({ branch: branchBody({ current_state: "init" }) }) : json({ branch: branchBody({ current_state: "init" }) }));
    expect(await code(neverReady.admin.createBranch(project, create))).toBe("NEON_ADMIN_TIMEOUT");
  });

  it("rejects a malformed operation id, request or mismatched response", async () => {
    const op = adminWith(() => json({ branch: branchBody(), operations: [{ id: "../x", status: "running" }] }));
    expect(await code(op.admin.createBranch(project, create))).toBe("NEON_ADMIN_INVALID");
    const { admin, calls } = adminWith(() => created());
    expect(await code(admin.createBranch(project, { ...create, parent_id: "main" }))).toBe("NEON_ADMIN_CONFIG");
    expect(await code(admin.createBranch(project, { ...create, name: "bad name!" }))).toBe("NEON_ADMIN_CONFIG");
    expect(await code(admin.createBranch(project, { ...create, expires_at: "never" }))).toBe("NEON_ADMIN_CONFIG");
    expect(calls).toHaveLength(0);
    const other = adminWith(() => created({ project_id: "another-project" }));
    expect(await code(other.admin.createBranch(project, create))).toBe("NEON_ADMIN_INVALID");
    const renamed = adminWith(() => created({ name: "something-else" }));
    expect(await code(renamed.admin.createBranch(project, create))).toBe("NEON_ADMIN_INVALID");
  });

  it("fails loudly and value-free when a plan limit is hit", async () => {
    for (const [status, body] of [[402, "payment required"], [422, JSON.stringify({ code: "BRANCHES_LIMIT_EXCEEDED", message: "branch limit exceeded for project-secret-name" })], [409, "quota"]] as const) {
      const { admin } = adminWith(() => new Response(body, { status }));
      const text = await message(admin.createBranch(project, create));
      expect(text).toContain("NEON_ADMIN_LIMIT");
      expect(text).toContain("plan limit");
      expect(text).not.toContain("project-secret-name");
      expect(text).not.toContain(apiKey);
    }
  });

  it("treats an unrelated 4xx or an unreadable body as a plain HTTP error", async () => {
    const other = adminWith(() => new Response("name already used", { status: 422 }));
    expect(await code(other.admin.createBranch(project, create))).toBe("NEON_ADMIN_HTTP");
    const unreadable = adminWith(() => {
      const response = new Response("x", { status: 406 });
      vi.spyOn(response, "text").mockRejectedValue(new Error("broken body"));
      return response;
    });
    expect(await code(unreadable.admin.createBranch(project, create))).toBe("NEON_ADMIN_HTTP");
    const forbidden = adminWith(() => new Response("limit", { status: 403 }));
    expect(await code(forbidden.admin.createBranch(project, create))).toBe("NEON_ADMIN_HTTP");
  });

  it("works with the default clock, sleep and fetch", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") return json({ branch: branchBody(), operations: [{ id: "op-1", status: "running" }] });
      if (String(input).includes("/operations/")) return json({ operation: { id: "op-1", status: ++polls < 2 ? "running" : "finished" } });
      return json({ branch: branchBody() });
    });
    vi.stubGlobal("fetch", request);
    const pending = neonAdmin(apiKey).createBranch(project, create);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).id).toBe("br-new-1");
  });
});

describe("get, list and connection URIs", () => {
  it("reads one branch and lists branches", async () => {
    const { admin } = adminWith((c) => c.url.endsWith("/branches") ? json({ branches: [branchBody()] }) : json({ branch: branchBody() }));
    expect((await admin.getBranch(project, "br-new-1")).name).toContain("pre-deploy-");
    expect(await admin.listBranches(project)).toHaveLength(1);
  });

  it("fetches a fresh URI for the branch, database and role", async () => {
    const { admin, calls } = adminWith(() => json({ uri: "postgres://example.invalid/db" }));
    expect(await admin.connectionUri(project, { branch_id: "br-new-1", database_name: "app", role_name: "owner", pooled: true })).toBe("postgres://example.invalid/db");
    expect(calls[0]!.url).toBe(`${base}/connection_uri?branch_id=br-new-1&database_name=app&role_name=owner&pooled=true`);
    expect(await code(admin.connectionUri(project, { branch_id: "br-new-1", database_name: "app", role_name: "o;wner", pooled: false }))).toBe("NEON_ADMIN_CONFIG");
    expect(await code(admin.connectionUri(project, { branch_id: "br-new-1", database_name: "a/b", role_name: "owner", pooled: false }))).toBe("NEON_ADMIN_CONFIG");
  });
});

describe("deleteBranch", () => {
  const router = (branch: Record<string, unknown>, deleted: Call[] = []) => (c: Call) => {
    if (c.method === "DELETE") { deleted.push(c); return json({ branch: branchBody(), operations: [{ id: "op-9", status: "running" }] }); }
    if (c.url.includes("/operations/")) return json({ operation: { id: "op-9", status: "finished" } });
    return json({ branch: branchBody(branch) });
  };

  it("deletes a rehearsal or pre-deploy branch and waits for the operation", async () => {
    const deleted: Call[] = [];
    const { admin, calls } = adminWith(router({ name: "rehearse-abc1234-9" }, deleted));
    await admin.deleteBranch(project, "br-new-1", ["rehearse-"]);
    expect(deleted).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/operations/op-9"))).toBe(true);
    const snapshot = adminWith(router({}, deleted));
    await snapshot.admin.deleteBranch(project, "br-new-1", ["rehearse-", "pre-deploy-"]);
    expect(deleted).toHaveLength(2);
  });

  it("accepts a delete response without operations", async () => {
    const { admin } = adminWith((c) => c.method === "DELETE" ? json({}) : json({ branch: branchBody() }));
    await admin.deleteBranch(project, "br-new-1", ["pre-deploy-"]);
  });

  it("refuses anything that is not a disposable branch, without sending a DELETE", async () => {
    const cases: Record<string, unknown>[] = [
      { name: "production" }, { name: "main" }, { name: "dev-step14-rehearsal" },
      { default: true }, { primary: true }, { protected: true },
      { id: "br-other" }, { project_id: "another-project" },
    ];
    for (const over of cases) {
      const deleted: Call[] = [];
      const { admin } = adminWith(router(over, deleted));
      expect(await code(admin.deleteBranch(project, "br-new-1", ["rehearse-"]))).toBe("NEON_ADMIN_REFUSED_TARGET");
      expect(deleted).toHaveLength(0);
    }
    const none = adminWith(router({ name: "rehearse-abc1234-9" }));
    expect(await code(none.admin.deleteBranch(project, "br-new-1", []))).toBe("NEON_ADMIN_REFUSED_TARGET");
  });

  it("reports a missing branch as not found", async () => {
    const { admin } = adminWith(() => new Response("", { status: 404 }));
    expect(await code(admin.deleteBranch(project, "br-new-1", ["rehearse-"]))).toBe("NEON_ADMIN_NOT_FOUND");
  });
});

describe("prune", () => {
  const pattern = /^pre-deploy-\d{8}T\d{6}Z-[0-9a-f]{7}$/;
  const snap = (n: number, over: Record<string, unknown> = {}) => branchBody({
    id: `br-snap-${n}`, name: `pre-deploy-202610${String(n).padStart(2, "0")}T120000Z-abcdef${n % 10}`,
    created_at: `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`, ...over,
  });
  function plane(branches: Record<string, unknown>[], failing: string[] = []) {
    const deleted: string[] = [];
    const handler = (c: Call) => {
      if (c.method === "DELETE") {
        const id = c.url.split("/branches/")[1]!;
        if (failing.includes(id)) return new Response("", { status: 500 });
        deleted.push(id);
        return json({ operations: [] });
      }
      if (c.url.endsWith("/branches")) return json({ branches });
      const id = c.url.split("/branches/")[1]!;
      return json({ branch: branches.find((b) => b.id === id) });
    };
    return { deleted, ...adminWith(handler) };
  }
  const options = { prefix: "pre-deploy-", namePattern: pattern, keep: 5 };

  it("keeps the newest five snapshots and deletes the rest", async () => {
    const { admin, deleted } = plane([1, 2, 3, 4, 5, 6, 7, 8].map((n) => snap(n)));
    expect(await admin.prune(project, options)).toEqual({ kept: 5, deleted: 3 });
    expect(deleted.sort()).toEqual(["br-snap-1", "br-snap-2", "br-snap-3"]);
  });

  it("ignores other branches, mis-named snapshots and does nothing when under the limit", async () => {
    const others = [
      branchBody({ id: "br-prod", name: "production" }), branchBody({ id: "br-reh", name: "rehearse-abc1234-1" }),
      branchBody({ id: "br-odd", name: "pre-deploy-manual-test" }),
    ];
    const { admin, deleted } = plane([...others, snap(1), snap(2)]);
    expect(await admin.prune(project, options)).toEqual({ kept: 2, deleted: 0 });
    expect(deleted).toEqual([]);
  });

  it("orders ties and branches without a creation time deterministically", async () => {
    const same = "2026-10-05T12:00:00Z";
    const a = snap(1, { id: "br-a", name: "pre-deploy-20261005T120000Z-aaaaaaa", created_at: same });
    const b = snap(2, { id: "br-b", name: "pre-deploy-20261005T120000Z-bbbbbbb", created_at: same });
    const c = snap(3, { id: "br-c", name: "pre-deploy-20261001T120000Z-ccccccc", created_at: undefined });
    const { admin, deleted } = plane([a, c, b]);
    await admin.prune(project, { ...options, keep: 1 });
    expect(deleted.sort()).toEqual(["br-a", "br-c"]);
    const reversed = plane([b, a, c]);
    await reversed.admin.prune(project, { ...options, keep: 1 });
    expect(reversed.deleted.sort()).toEqual(["br-a", "br-c"]);
  });

  it("fails loudly after trying every delete when one fails", async () => {
    const { admin, deleted } = plane([1, 2, 3, 4].map((n) => snap(n)), ["br-snap-1"]);
    const text = await message(admin.prune(project, { ...options, keep: 1 }));
    expect(text).toContain("NEON_ADMIN_PRUNE_FAILED");
    expect(text).toContain("1 of 3");
    expect(deleted.sort()).toEqual(["br-snap-2", "br-snap-3"]);
  });

  it("never prunes a protected snapshot and refuses an invalid keep", async () => {
    const { admin, deleted } = plane([snap(1, { protected: true }), snap(2), snap(3)]);
    expect(await code(admin.prune(project, { ...options, keep: 1 }))).toBe("NEON_ADMIN_PRUNE_FAILED");
    expect(deleted).toEqual(["br-snap-2"]);
    expect(await code(admin.prune(project, { ...options, keep: 0 }))).toBe("NEON_ADMIN_CONFIG");
    expect(await code(admin.prune(project, { ...options, keep: 1.5 }))).toBe("NEON_ADMIN_CONFIG");
  });
});

export type { NeonAdmin };
