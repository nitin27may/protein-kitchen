import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import { getDb } from "../lib/server/context";
import { openDb, type DbHandle } from "./helpers/db";
import { addIngredient, addRecipe, approveFixture } from "./helpers/library-fixture";

const cache = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("next/cache", () => ({ unstable_cache: (...args: unknown[]) => { cache.calls.push(args); return args[0]; } }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));

import { libraryPhotoManifest, MANIFEST_UNAVAILABLE_CODE, readLibraryManifest } from "../lib/library-photos/manifest";
import { LIBRARY_PHOTOS_TAG } from "../lib/library-photos/tags";
import { EMPTY_LIBRARY_MANIFEST } from "../lib/library-photos/model";

let h: DbHandle;
beforeEach(async () => {
  h = await openDb();
  vi.restoreAllMocks();
  vi.mocked(getDb).mockResolvedValue(h.db);
});

describe("library photo manifest", () => {
  it("is cached for an hour under the library-photos tag, created once on first use", async () => {
    await libraryPhotoManifest();
    await libraryPhotoManifest();
    expect(cache.calls).toHaveLength(1);
    expect(cache.calls[0]!.slice(1)).toEqual([["library-photo-manifest", "v1"], { tags: [LIBRARY_PHOTOS_TAG], revalidate: 3600 }]);
    expect(LIBRARY_PHOTOS_TAG).toBe("library-photos");
  });

  it("is empty when nothing is approved", async () => {
    expect(await readLibraryManifest(h.db)).toEqual({ recipes: {}, ingredients: {} });
    expect(await libraryPhotoManifest()).toEqual(EMPTY_LIBRARY_MANIFEST);
  });

  it("lists the cover and the ordered photos per subject as plain JSON", async () => {
    const store = createMemoryStore();
    await addRecipe(h.db, "falafel-bowl");
    await addIngredient(h.db, "paneer");
    const first = await approveFixture(h.db, store, { candidateKey: "commons:a" });
    const second = await approveFixture(h.db, store, { candidateKey: "openverse:b", origin: "openverse" });
    const paneer = await approveFixture(h.db, store, { subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:p" });
    const manifest = await libraryPhotoManifest();
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(Object.keys(manifest.recipes)).toEqual(["falafel-bowl"]);
    const recipe = manifest.recipes["falafel-bowl"]!;
    expect(recipe.cover.uid).toBe(first);
    expect(recipe.photos.map((p) => p.uid)).toEqual([first, second]);
    expect(recipe.photos[1]).toEqual({
      uid: second, w: 1280, h: 960, title: "Falafel", author: "A. Person", licence: "CC BY 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://commons.example.test/falafel", origin: "openverse", candidateKey: "openverse:b",
    });
    expect(manifest.ingredients.paneer!.cover.uid).toBe(paneer);
  });

  it("degrades to empty and logs only a fixed code when the database is unreachable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getDb).mockRejectedValue(new Error("connect ECONNREFUSED secret-host"));
    expect(await libraryPhotoManifest()).toEqual(EMPTY_LIBRARY_MANIFEST);
    expect(log).toHaveBeenCalledWith(MANIFEST_UNAVAILABLE_CODE);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
