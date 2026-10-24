import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import { photoKeys } from "../lib/photos/keys";
import * as s from "../lib/db/schema";
import { writeSavedView } from "../lib/human/saved-views";
import { openPrivateStateRepository, StateGitHubError } from "../lib/sync/github";
import { readStateRunStatus, runStateSync, stateTargetKey } from "../lib/sync/run";
import { reconcileState } from "../lib/sync/publish";
import { readStateSyncStatus } from "../lib/sync/snapshot";
import { fixtureConfiguration as config, fixtureTime, githubFixture } from "./helpers/github-state";
import { openDb, type DbHandle } from "./helpers/db";

const fixture = githubFixture();
const targetKey = stateTargetKey(config);
let h: DbHandle;
const store = createMemoryStore();
const repository = () => openPrivateStateRepository(config, fixture.fetch, () => fixtureTime);
const run = (id?: string) => runStateSync(h.db, targetKey, ["saved-views"], { repository, store }, id);
const job = async () => (await h.db.select().from(s.stateSyncJobs))[0]!;
const dirty = () => readStateSyncStatus(h.db, ["saved-views"]);
beforeAll(() => fixture.start());
afterAll(() => fixture.close());
beforeEach(async () => {
  fixture.reset(); h = await openDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("persisted private-state run coordination", () => {
  it("records authoritative success, target receipts and a checkpoint, then replays without any remote work", async () => {
    const request = randomUUID();
    expect(await readStateRunStatus(h.db, targetKey)).toMatchObject({ status: "idle", active: false, lastSuccessAt: null });
    await writeSavedView(h.db, { list: "recipes", query: "synthetic" });
    expect(await run(request)).toEqual({ state: "success", replayed: false });
    expect(await job()).toMatchObject({ checkpointCommit: fixture.head, pending: null, leaseToken: null, acknowledged: { "saved-views": 1 } });
    expect(await readStateRunStatus(h.db, targetKey)).toMatchObject({ status: "success", active: false, lastSuccessAt: expect.any(String) });
    expect(await dirty()).toMatchObject([{ pending: false, exportedRevision: 1 }]);
    fixture.requests.length = 0;
    expect(await run(request.toUpperCase())).toEqual({ state: "success", replayed: true });
    expect(fixture.requests).toEqual([]);
    expect(await h.db.select().from(s.stateSyncRequests)).toMatchObject([{ id: request, status: "success", completedAt: expect.any(String) }]);
    const head = fixture.head;
    expect(await run()).toMatchObject({ state: "success" });
    expect(fixture.head).toBe(head);
    expect(stateTargetKey({ ...config, owner: config.owner.toUpperCase(), repository: config.repository.toUpperCase() })).toBe(targetKey);
    expect(stateTargetKey({ ...config, branch: "another" })).not.toBe(targetKey);
  });

  it("rejects invalid target, id and private selections before acquisition", async () => {
    await expect(runStateSync(h.db, "bad", ["saved-views"], { repository, store })).rejects.toThrow("Invalid");
    await expect(run("bad")).rejects.toThrow("Invalid");
    await expect(runStateSync(h.db, targetKey, ["personal-recipe-feedback"], { repository, store })).rejects.toThrow("selection");
    expect(await h.db.select().from(s.stateSyncJobs)).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("refuses a request id previously bound to another pinned target", async () => {
    const id = randomUUID();
    await run(id);
    await expect(runStateSync(h.db, "b".repeat(64), ["saved-views"], { repository, store }, id)).rejects.toThrow("different target");
    expect(await h.db.select().from(s.stateSyncJobs)).toHaveLength(1);
  });

  it("does not admit a second worker while a persisted lease is live", async () => {
    await h.db.insert(s.stateSyncJobs).values({ targetKey, status: "running", leaseToken: "another-worker", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await run()).toEqual({ state: "busy", replayed: false });
    expect(await h.db.select().from(s.stateSyncRequests)).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("takes over an expired lease and marks its old request interrupted", async () => {
    await h.db.insert(s.stateSyncJobs).values({ targetKey, status: "running", leaseToken: "dead-worker", leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    const old = randomUUID();
    await h.db.insert(s.stateSyncRequests).values({ id: old, targetKey, status: "running", startedAt: "2000-01-01T00:00:00.000Z" });
    expect(await run()).toMatchObject({ state: "success" });
    expect(await h.db.select().from(s.stateSyncRequests).where(eq(s.stateSyncRequests.id, old))).toMatchObject([{ status: "error", completedAt: expect.any(String) }]);
  });

  it.each(["expired", "replaced"])("fences a %s worker before its next remote call or status/acknowledgement write", async (kind) => {
    const actual = await repository();
    const open = async () => {
      await h.db.update(s.stateSyncJobs).set(kind === "expired"
        ? { leaseExpiresAt: "2000-01-01T00:00:00.000Z" }
        : { leaseToken: "replacement-worker", status: "running", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      return actual;
    };
    fixture.requests.length = 0;
    expect(await runStateSync(h.db, targetKey, ["saved-views"], { repository: open, store })).toMatchObject({ state: "error" });
    expect(fixture.requests).toEqual([]);
    expect(await dirty()).toMatchObject([{ exportedRevision: 0, pending: true }]);
    expect(await job()).toMatchObject({ status: "running", checkpointCommit: null });
    expect(console.error).toHaveBeenCalledWith("Private state sync did not complete.", { code: "lease-lost" });
  });

  it("persists sanitized network failure without falsely recording success and permits the same request to retry", async () => {
    const id = randomUUID();
    const fail = async () => { throw new StateGitHubError(503, true); };
    expect(await runStateSync(h.db, targetKey, ["saved-views"], { repository: fail, store }, id)).toMatchObject({ state: "error" });
    expect(await job()).toMatchObject({ status: "error", errorCode: "github-request-failed", lastSuccessAt: null, leaseToken: null });
    expect(JSON.stringify(await job())).not.toContain(config.privateKey);
    expect(await run(id)).toMatchObject({ state: "success", replayed: false });
  });

  it("keeps a failed publication intent and safely retries when remote still matches the baseline", async () => {
    fixture.intercept = (req, res) => {
      if (req.method !== "PATCH") return false;
      fixture.json(res, { secret: "NEVER_LOG_THIS" }, 503); return true;
    };
    expect(await run()).toMatchObject({ state: "error" });
    expect(await job()).toMatchObject({ status: "error", checkpointCommit: null, pending: { revisions: { "saved-views": 1 } } });
    expect(await dirty()).toMatchObject([{ pending: true }]);
    fixture.intercept = undefined;
    expect(await run()).toMatchObject({ state: "success" });
    expect(await dirty()).toMatchObject([{ pending: false }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("NEVER_LOG_THIS");
  });

  it.each(["acknowledgement", "request-status"])("atomically rolls back checkpoint, receipts and last-success on %s failure, then recovers remote success without a duplicate commit", async (kind) => {
    const table = kind === "acknowledgement" ? "sync_state" : "state_sync_requests";
    const when = kind === "acknowledgement" ? "NEW.exported_revision > 0" : "NEW.status = 'success'";
    await h.failWrite(table, "UPDATE", "sync_completion_failure", when);
    expect(await run()).toMatchObject({ state: "error" });
    const head = fixture.head;
    expect(await job()).toMatchObject({ checkpointCommit: null, acknowledged: {}, lastSuccessAt: null, pending: { revisions: { "saved-views": 1 } } });
    expect(await dirty()).toMatchObject([{ exportedRevision: 0, pending: true }]);
    await h.dropFailure(table, "sync_completion_failure");
    await writeSavedView(h.db, { list: "recipes", query: "newer-after-remote-success" });
    fixture.requests.length = 0;
    expect(await run()).toMatchObject({ state: "success" });
    expect(fixture.head).toBe(head);
    expect(fixture.requests.some((request) => request.method !== "GET" && !request.path.includes("access_tokens"))).toBe(false);
    expect(await dirty()).toMatchObject([{ revision: 2, exportedRevision: 0, pending: true }]);
    expect(await job()).toMatchObject({ acknowledged: { "saved-views": 1 }, checkpointCommit: head });
    expect(await run()).toMatchObject({ state: "success" });
    expect(fixture.head).not.toBe(head);
    expect(await dirty()).toMatchObject([{ revision: 2, exportedRevision: 2, pending: false }]);
  });

  it("recovers an already-published photo receipt without requiring local photo bytes", async () => {
    const uid = randomUUID();
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#884422" } }).webp().toBuffer();
    const keys = photoKeys(uid);
    await store.put(keys.master, bytes, "image/webp"); await store.put(keys.thumb, bytes, "image/webp");
    await h.db.insert(s.photos).values({
      uid, ingredientSlug: "synthetic", origin: "upload", width: 20, height: 20,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await h.failWrite("sync_state", "UPDATE", "ack_failure", "NEW.exported_revision > 0");
    expect(await runStateSync(h.db, targetKey, ["photos"], { repository, store })).toMatchObject({ state: "error" });
    await h.dropFailure("sync_state", "ack_failure");
    await store.delete(keys.master); await store.delete(keys.thumb);
    const missingStore = { get: vi.fn(async () => { throw new Error("Photo was deleted locally after remote success."); }) };
    expect(await runStateSync(h.db, targetKey, ["photos"], { repository, store: missingStore })).toMatchObject({ state: "success" });
    expect(missingStore.get).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ acknowledged: { photos: 1 } });
  });

  it("reports an out-of-band managed edit without uploads, forced overwrites or false acknowledgement", async () => {
    await run();
    const previous = await job();
    await writeSavedView(h.db, { list: "recipes", query: "newer" });
    fixture.edit({ "protein-kitchen/manifest.json": "out-of-band conflict" });
    fixture.requests.length = 0;
    expect(await run()).toMatchObject({ state: "conflict" });
    expect(await job()).toMatchObject({ status: "conflict", errorCode: "remote-conflict", checkpointCommit: previous.checkpointCommit, lastSuccessAt: previous.lastSuccessAt });
    expect(await dirty()).toMatchObject([{ pending: true, exportedRevision: 1 }]);
    expect(fixture.requests.some((request) => request.method !== "GET" && !request.path.includes("access_tokens"))).toBe(false);
    expect(await run()).toMatchObject({ state: "conflict" });
  });

  it("refuses corrupt persisted pending data and keeps the receipt for owner investigation", async () => {
    await h.db.insert(s.stateSyncJobs).values({ targetKey, pending: { revisions: { "saved-views": 0 }, files: {} } });
    expect(await run()).toMatchObject({ state: "error" });
    expect(await job()).toMatchObject({ pending: { revisions: { "saved-views": 0 } }, errorCode: "sync-failed" });
    const repo = await repository();
    await expect(reconcileState(repo, {}, null)).rejects.toThrow("pending");
    await expect(reconcileState(repo, { "protein-kitchen/manifest.json": "bad" }, null)).rejects.toThrow("pending");
    await expect(reconcileState(repo, { "protein-kitchen/manifest.json": "a".repeat(40), "outside/unsafe": "a".repeat(40) }, null)).rejects.toThrow("pending");
    await expect(reconcileState(repo, { "protein-kitchen/manifest.json": "a".repeat(40), "protein-kitchen/../unsafe": "a".repeat(40) }, null)).rejects.toThrow("pending");
  });

  it("surfaces an unavailable error-status write rather than pretending the run was recorded", async () => {
    await h.failWrite("state_sync_jobs", "UPDATE", "status_failure", "NEW.status = 'error'");
    await expect(runStateSync(h.db, targetKey, ["saved-views"], {
      repository: async () => { throw new Error("Private failure"); }, store,
    })).rejects.toThrow();
    expect(await job()).toMatchObject({ status: "running", lastSuccessAt: null });
  });

  it("refuses acquisition when no idempotency receipt can be persisted", async () => {
    await h.client.exec(`CREATE FUNCTION skip_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_request BEFORE INSERT ON state_sync_requests FOR EACH ROW EXECUTE FUNCTION skip_request();`);
    await expect(run()).rejects.toThrow("different target");
    expect(await h.db.select().from(s.stateSyncJobs)).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("does not publish when the pending-intent compare-and-set affects no row", async () => {
    await h.client.exec(`CREATE FUNCTION skip_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_pending BEFORE UPDATE ON state_sync_jobs
      FOR EACH ROW WHEN (NEW.pending IS NOT NULL AND OLD.pending IS NULL) EXECUTE FUNCTION skip_pending();`);
    expect(await run()).toMatchObject({ state: "error" });
    expect(await job()).toMatchObject({ pending: null, checkpointCommit: null, lastSuccessAt: null, errorCode: "lease-lost" });
    expect(fixture.requests.some((request) => request.method !== "GET" && !request.path.includes("access_tokens"))).toBe(false);
  });

  it("refuses to acknowledge after a lease expires during the final remote confirmation", async () => {
    const actual = await repository();
    let trees = 0;
    const wrapped = { ...actual, tree: async (id: string) => {
      const value = await actual.tree(id);
      if (++trees === 3) await h.db.update(s.stateSyncJobs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` });
      return value;
    } };
    expect(await runStateSync(h.db, targetKey, ["saved-views"], { repository: async () => wrapped, store })).toMatchObject({ state: "error" });
    expect(await job()).toMatchObject({ checkpointCommit: null, lastSuccessAt: null });
    expect(await dirty()).toMatchObject([{ pending: true, exportedRevision: 0 }]);
    expect(await run()).toMatchObject({ state: "success" });
  });
});
