import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import { verifyLibraryVersion } from "../lib/db/library-version";
import { ctx, getData, getDb, getHealthDb } from "../lib/server/context";
import type { DataSet } from "../lib/data/load";
import type { Db } from "../lib/db/client";

vi.mock("../lib/data/load", () => ({ loadData: vi.fn() }));
vi.mock("../lib/db/client", () => ({ openDb: vi.fn() }));
vi.mock("../lib/db/library-version", () => ({ verifyLibraryVersion: vi.fn() }));

const data: DataSet = {
  ingredients: new Map(), recipes: new Map(), techniques: new Map(), habits: [],
  micros: {}, renames: {}, issues: [], ingredientFiles: new Map(), recipeFiles: new Map(),
  overrides: {
    kcal_check_skip: {}, kcal_per_serving_ok: {}, dry_without_cooked_yield: {},
    routine_item_max_g: { default: 6, items: {} },
  },
};
// The context never queries db directly; it forwards the handle to the version verifier.
const db: Db = Object.create(null);
const handle = { db, close: vi.fn().mockResolvedValue(undefined) };

function resetContext() {
  Reflect.deleteProperty(globalThis, "__pkCtx");
}
beforeEach(() => {
  resetContext();
  vi.clearAllMocks();
  vi.mocked(loadData).mockReturnValue(data);
  vi.mocked(openDb).mockReset().mockResolvedValue(handle);
  vi.mocked(verifyLibraryVersion).mockReset().mockResolvedValue(undefined);
});
afterEach(resetContext);

describe("async application readiness", () => {
  it("the health pool is shared with getDb and skips the version check", async () => {
    expect(await getHealthDb()).toBe(db);
    expect(await getHealthDb()).toBe(db);
    expect(openDb).toHaveBeenCalledTimes(1);
    expect(verifyLibraryVersion).not.toHaveBeenCalled();
    expect(await getDb()).toBe(db);
    expect(openDb).toHaveBeenCalledTimes(1);
  });
  it("loading data or building context never opens a database", () => {
    expect(getData()).toBe(data);
    expect(ctx().data).toBe(data);
    expect(loadData).toHaveBeenCalledTimes(1);
    expect(openDb).not.toHaveBeenCalled();
    expect(verifyLibraryVersion).not.toHaveBeenCalled();
  });

  it("reports invalid library content before trying database verification", () => {
    vi.mocked(loadData).mockReturnValue({ ...data, issues: [{ file: "synthetic.json", message: "fixture invalid" }] });
    expect(() => ctx()).toThrow("synthetic.json: fixture invalid");
    expect(openDb).not.toHaveBeenCalled();
  });

  it("shares a single in-flight verified pool and version check across concurrent requests", async () => {
    let resolve!: (value: typeof handle) => void;
    vi.mocked(openDb).mockReturnValue(new Promise((ready) => { resolve = ready; }));
    const requests = [getDb(), getDb(), getDb()];
    expect(openDb).toHaveBeenCalledTimes(1);
    expect(verifyLibraryVersion).not.toHaveBeenCalled();
    resolve(handle);
    expect(await Promise.all(requests)).toEqual([db, db, db]);
    expect(verifyLibraryVersion).toHaveBeenCalledExactlyOnceWith(db, data);
    expect(await getDb()).toBe(db);
    expect(openDb).toHaveBeenCalledTimes(1);
  });

  it("fails every waiting request on branch verification failure, then retries pool creation", async () => {
    vi.mocked(openDb).mockRejectedValueOnce(new Error("branch refused"));
    const results = await Promise.allSettled([getDb(), getDb()]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(ctx().handle).toBeUndefined();
    expect(verifyLibraryVersion).not.toHaveBeenCalled();
    expect(await getDb()).toBe(db);
    expect(openDb).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read-only version check without creating duplicate pools", async () => {
    vi.mocked(verifyLibraryVersion).mockRejectedValueOnce(new Error("seed needed"));
    await expect(getDb()).rejects.toThrow("seed needed");
    expect(await getDb()).toBe(db);
    expect(openDb).toHaveBeenCalledTimes(1);
    expect(verifyLibraryVersion).toHaveBeenCalledTimes(2);
  });
});
