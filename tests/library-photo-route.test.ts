import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import { setBlobStore } from "../lib/blob";
import * as s from "../lib/db/schema";
import { libraryPhotoKeys, photoKeys } from "../lib/photos/keys";
import { getDb } from "../lib/server/context";
import { openDb, type DbHandle } from "./helpers/db";
import { addRecipe, approveFixture } from "./helpers/library-fixture";

vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ routeAccess: vi.fn() }));
vi.mock("../lib/auth/household-access", () => ({ memberHouseholdAccess: vi.fn() }));

import { routeAccess } from "../lib/auth/access";
import { memberHouseholdAccess } from "../lib/auth/household-access";
import { GET as libraryGet } from "../app/library-photos/[uid]/[variant]/route";
import { GET as householdGet } from "../app/photos/[uid]/[variant]/route";

let h: DbHandle;
let store: ReturnType<typeof createMemoryStore>;
let uid: string;
const call = (get: typeof libraryGet, id: string, variant: string) => get(new Request(`http://x.test/${id}/${variant}`), { params: Promise.resolve({ uid: id, variant }) });

beforeEach(async () => {
  vi.restoreAllMocks();
  h = await openDb();
  store = createMemoryStore();
  setBlobStore(store);
  vi.mocked(getDb).mockResolvedValue(h.db);
  await addRecipe(h.db, "falafel-bowl");
  uid = await approveFixture(h.db, store);
});

describe("GET /library-photos/<uid>/<variant>", () => {
  it("serves the master and thumb publicly with long-lived shared-cache headers and an ETag from the master hash", async () => {
    const [row] = await h.db.select({ sha: s.libraryPhotos.sha256 }).from(s.libraryPhotos);
    for (const variant of ["master", "thumb"] as const) {
      const response = await call(libraryGet, uid, variant);
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "content-type": "image/webp",
        "cache-control": "public, max-age=86400",
        "cdn-cache-control": "public, max-age=2592000, stale-while-revalidate=86400",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        etag: variant === "master" ? `"${row!.sha}"` : `"${row!.sha}-thumb"`,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      expect(body).toEqual((await store.get(libraryPhotoKeys(uid)[variant]))!.bytes);
    }
    expect(vi.mocked(routeAccess)).not.toHaveBeenCalled();
  });

  it("answers 404 with a short public cache for a bad uid, a bad variant, an unknown uid and a row without a file", async () => {
    await store.delete(libraryPhotoKeys(uid).thumb);
    const stray = randomUUID();
    await store.put(libraryPhotoKeys(stray).master, new Uint8Array([1, 2, 3]), "image/webp");
    for (const [id, variant] of [["not-a-uid", "master"], [uid, "original"], [randomUUID(), "master"], [stray, "master"], [uid, "thumb"]] as const) {
      const response = await call(libraryGet, id, variant);
      expect(response.status, `${id} ${variant}`).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      expect(response.headers.get("cdn-cache-control")).toBeNull();
    }
  });

  it("answers 503 without caching and logs a fixed code when the database or store fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getDb).mockRejectedValue(new Error("connect ECONNREFUSED secret-host"));
    const response = await call(libraryGet, uid, "master");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith("LIBRARY_PHOTO_UNAVAILABLE");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-host");
  });
});

describe("the household photo route stays private", () => {
  it("serves a household photo and its 404 as private, no-store", async () => {
    await h.db.insert(s.households).values({ id: "a", name: "First" });
    vi.mocked(routeAccess).mockResolvedValue({ member: { userId: "a" } } as never);
    vi.mocked(memberHouseholdAccess).mockResolvedValue({ householdId: "a" } as never);
    const own = randomUUID();
    await h.db.insert(s.photos).values({ householdId: "a", recipeId: 1, uid: own, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" });
    await store.put(photoKeys(own).master, new Uint8Array([1]), "image/webp");
    const ok = await call(householdGet as typeof libraryGet, own, "master");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("cdn-cache-control")).toBeNull();
    // A library uid is not served by the household route, and says so privately.
    const miss = await call(householdGet as typeof libraryGet, uid, "master");
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("private, no-store");
  });
});
