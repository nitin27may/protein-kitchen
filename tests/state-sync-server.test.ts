import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../lib/server/context";
import { getBlobStore } from "../lib/blob";
import { openPrivateStateRepository } from "../lib/sync/github";
import { runStateSync, readStateRunStatus } from "../lib/sync/run";
import { readStateSyncStatus } from "../lib/sync/snapshot";
import { configuredStateSync, stateSyncSettings } from "../lib/sync/server";
import { localStateTestFetch } from "../lib/sync/test-fetch";
import * as configuration from "../lib/sync/config";
import { createMemoryStore } from "../lib/blob/memory";
import { fixtureConfiguration as config } from "./helpers/github-state";
import { openDb } from "./helpers/db";
import * as s from "../lib/db/schema";
import { requireMember } from "../lib/auth/access";
import { eq } from "drizzle-orm";

vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/blob", () => ({ getBlobStore: vi.fn() }));
vi.mock("../lib/sync/github", async (actual) => ({ ...await actual<typeof import("../lib/sync/github")>(), openPrivateStateRepository: vi.fn() }));
vi.mock("../lib/sync/run", async (actual) => ({ ...await actual<typeof import("../lib/sync/run")>(), runStateSync: vi.fn(), readStateRunStatus: vi.fn() }));
vi.mock("../lib/sync/snapshot", async (actual) => ({ ...await actual<typeof import("../lib/sync/snapshot")>(), readStateSyncStatus: vi.fn() }));
const env = {
  STATE_SYNC_ENABLED: "true", STATE_SYNC_CLASSES: "saved-views", STATE_SYNC_HOUSEHOLD_ID: "a",
  STATE_GITHUB_APP_ID: String(config.appId), STATE_GITHUB_INSTALLATION_ID: String(config.installationId),
  STATE_GITHUB_REPOSITORY_ID: String(config.repositoryId), STATE_GITHUB_OWNER: config.owner,
  STATE_GITHUB_REPOSITORY: config.repository, STATE_GITHUB_BRANCH: config.branch, STATE_GITHUB_PRIVATE_KEY: config.privateKey,
  NODE_ENV: "development", DATABASE_ENV: "development", AUTH_TEST_MAILBOX: "1", VERCEL: "", VERCEL_ENV: "",
  DATABASE_URL: "postgres://fixture@127.0.0.1:54329/protein_kitchen_e2e", STATE_SYNC_TEST_GITHUB_URL: "",
};
beforeEach(() => {
  vi.resetAllMocks(); for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: 1 });
});
async function householdDb() {
  const { db } = await openDb();
  await db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await db.insert(s.people).values({ id: 1, householdId: "a", name: "Fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] });
  await db.insert(s.authUsers).values({ id: "owner", name: "Fixture", email: "fixture@example.test", emailVerified: true });
  await db.insert(s.householdMembers).values({ householdId: "a", userId: "owner", personId: 1, role: "owner" });
  return db;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("server-only wiring and safe owner status", () => {
  it("does not disguise an unexpected configuration-loader failure as a disabled instance", async () => {
    vi.spyOn(configuration, "stateSyncConfiguration").mockImplementationOnce(() => { throw new Error("Unexpected loader failure"); });
    await expect(stateSyncSettings()).rejects.toThrow("Unexpected loader failure");
    expect(getDb).not.toHaveBeenCalled();
  });
  it("does not read the database or credentials when disabled or previewed", async () => {
    for (const [key, value] of [["STATE_SYNC_ENABLED", "false"], ["VERCEL_ENV", "preview"]]) {
      vi.stubEnv(key!, value!);
      expect(await stateSyncSettings()).toMatchObject({ enabled: false, reason: expect.any(String) });
      await expect(configuredStateSync()).rejects.toThrow("not configured");
      vi.stubEnv(key!, env[key! as keyof typeof env]);
    }
    expect(getDb).not.toHaveBeenCalled();
    expect(openPrivateStateRepository).not.toHaveBeenCalled();
  });
  it("captures only target-local pending status, never treating another target's acknowledgement as success", async () => {
    vi.mocked(getDb).mockResolvedValue(await householdDb());
    vi.mocked(readStateRunStatus).mockResolvedValue({ status: "success", active: false, lastAttemptAt: null, lastSuccessAt: null, errorCode: null, acknowledged: { "saved-views": 1 } });
    vi.mocked(readStateSyncStatus).mockResolvedValue([
      { dataClass: "saved-views", revision: 3, exportedRevision: 3, changedAt: null, pending: false },
      { dataClass: "recipe-links", revision: 0, exportedRevision: 0, changedAt: null, pending: true },
      { dataClass: "photos", revision: 1, exportedRevision: 1, changedAt: null, pending: false },
    ]);
    expect(await stateSyncSettings()).toMatchObject({ enabled: true, classes: [
      { dataClass: "saved-views", pending: true }, { dataClass: "recipe-links", pending: true }, { dataClass: "photos", pending: true },
    ] });
  });
  it("lazily opens the exact repository and photo store only inside the acquired run", async () => {
    const db = await householdDb();
    const store = createMemoryStore();
    await store.put("synthetic.webp", Buffer.from("synthetic"), "image/webp");
    vi.mocked(getDb).mockResolvedValue(db);
    vi.mocked(getBlobStore).mockReturnValue(store);
    vi.mocked(runStateSync).mockImplementation(async (received, target, classes, dependencies, id) => {
      expect(received).toBe(db); expect(target).toMatch(/^[0-9a-f]{64}$/); expect(classes).toEqual(["saved-views"]); expect(id).toBe("synthetic-id");
      expect(getBlobStore).not.toHaveBeenCalled();
      await dependencies.repository();
      expect(await dependencies.store.get("synthetic.webp")).toMatchObject({ contentType: "image/webp" });
      return { state: "success", replayed: false };
    });
    expect(await configuredStateSync("synthetic-id")).toMatchObject({ state: "success" });
    expect(openPrivateStateRepository).toHaveBeenCalledWith(config, fetch);
    expect(runStateSync).toHaveBeenLastCalledWith(db, expect.any(String), ["saved-views"], expect.any(Object), "synthetic-id", { householdId: "a", access: undefined });
    vi.mocked(getBlobStore).mockClear();
    await configuredStateSync("synthetic-id", true);
    expect(runStateSync).toHaveBeenLastCalledWith(db, expect.any(String), ["saved-views"], expect.any(Object), "synthetic-id", { householdId: "a", access: expect.objectContaining({ householdId: "a", role: "owner" }) });
  });
  it("validates the local synthetic boundary before opening the database", async () => {
    vi.stubEnv("STATE_SYNC_TEST_GITHUB_URL", "http://127.0.0.1:3456");
    vi.stubEnv("VERCEL", "1");
    await expect(configuredStateSync()).rejects.toThrow("local browser");
    expect(getDb).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL", "");
    vi.mocked(getDb).mockResolvedValue(await householdDb());
    vi.mocked(runStateSync).mockImplementation(async (_db, _target, _classes, dependencies) => {
      await dependencies.repository(); return { state: "error", replayed: false };
    });
    await configuredStateSync();
    expect(openPrivateStateRepository).toHaveBeenCalledWith(config, expect.any(Function));
  });
  it("refuses foreign owners and stale membership before exposing status or opening transport", async () => {
    const db = await householdDb();
    vi.mocked(getDb).mockResolvedValue(db);
    vi.stubEnv("STATE_SYNC_HOUSEHOLD_ID", "b");
    expect(await stateSyncSettings()).toMatchObject({ enabled: false, reason: expect.stringContaining("this household") });
    await expect(configuredStateSync(undefined, true)).rejects.toThrow("this household");
    expect(readStateRunStatus).not.toHaveBeenCalled();
    expect(readStateSyncStatus).not.toHaveBeenCalled();
    expect(runStateSync).not.toHaveBeenCalled();
    expect(openPrivateStateRepository).not.toHaveBeenCalled();
    vi.stubEnv("STATE_SYNC_HOUSEHOLD_ID", "a");
    await db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "owner"));
    await expect(configuredStateSync(undefined, true)).rejects.toThrow("this household");
    await db.delete(s.householdMembers);
    expect(await stateSyncSettings()).toMatchObject({ enabled: false });
  });
  it("propagates unexpected membership infrastructure failures rather than reporting disabled configuration", async () => {
    vi.mocked(getDb).mockResolvedValue(await householdDb());
    vi.mocked(requireMember).mockRejectedValue(new Error("Database unavailable"));
    await expect(stateSyncSettings()).rejects.toThrow("Database unavailable");
  });
});

describe("synthetic GitHub transport cannot run against hosted or real data", () => {
  it.each([
    { NODE_ENV: "production" }, { DATABASE_ENV: "production" }, { AUTH_TEST_MAILBOX: "" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" },
    { DATABASE_URL: "postgres://fixture@neon.example/protein_kitchen_e2e" }, { DATABASE_URL: "postgres://fixture@127.0.0.1:54329/real_database" },
    { STATE_SYNC_TEST_GITHUB_URL: "https://127.0.0.1:3456" }, { STATE_SYNC_TEST_GITHUB_URL: "http://localhost:3456" },
    { STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1" }, { STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1:3456/path" },
    { STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1:3456/?secret=bad" }, { STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1:3456/#bad" },
    { STATE_SYNC_TEST_GITHUB_URL: "http://user:pass@127.0.0.1:3456" }, { STATE_SYNC_TEST_GITHUB_URL: "http://user@127.0.0.1:3456" },
    { STATE_GITHUB_APP_ID: "999" }, { STATE_GITHUB_INSTALLATION_ID: "999" }, { STATE_GITHUB_REPOSITORY_ID: "999" },
    { STATE_GITHUB_OWNER: "another" }, { STATE_GITHUB_REPOSITORY: "another" }, { STATE_GITHUB_BRANCH: "another" },
  ])("refuses unsafe override: %j", (override) => {
    expect(() => localStateTestFetch({ ...env, STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1:3456", ...override })).toThrow();
  });
  it("remaps only canonical GitHub URLs to the fixed loopback fixture, never following redirects", async () => {
    const call = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ synthetic: true }));
    const fetcher = localStateTestFetch({ ...env, STATE_SYNC_TEST_GITHUB_URL: "http://127.0.0.1:3456" });
    await fetcher("https://api.github.com/synthetic?recursive=1", { method: "POST", redirect: "follow" });
    expect(call).toHaveBeenCalledWith("http://127.0.0.1:3456/synthetic?recursive=1", { method: "POST", redirect: "error" });
    expect(() => fetcher("https://another.example/synthetic")).toThrow("non-GitHub");
    await fetcher("https://api.github.com/synthetic");
    expect(call).toHaveBeenLastCalledWith("http://127.0.0.1:3456/synthetic", { redirect: "error" });
    expect(() => localStateTestFetch({ ...env, DATABASE_URL: undefined })).toThrow();
    expect(() => localStateTestFetch({ ...env, STATE_SYNC_TEST_GITHUB_URL: undefined })).toThrow();
  });
});
