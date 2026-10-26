import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { readLibraryManifest } from "../lib/library-photos/manifest";
import { EMPTY_LIBRARY_MANIFEST, libraryPhotoUrl, type LibraryPhotoManifest } from "../lib/library-photos/model";
import { creditedPhotos, photoIndex, photosOfIngredient, photosOfRecipe } from "../lib/server/photo-index";
import { openDb, type DbHandle } from "./helpers/db";
import { addIngredient, addRecipe, approveFixture } from "./helpers/library-fixture";

let h: DbHandle;
let recipeId: number;
let library: LibraryPhotoManifest;
let libraryCover: string;

async function household(householdId: string, uid: string, over: Partial<typeof s.photos.$inferInsert> = {}) {
  await h.db.insert(s.photos).values({
    householdId, recipeId, uid, origin: "upload", sha256: "0".repeat(64), width: 10, height: 10, createdAt: "2026-11-02", updatedAt: "2026-11-02", ...over,
  });
}

beforeEach(async () => {
  h = await openDb();
  const store = createMemoryStore();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  recipeId = await addRecipe(h.db, "falafel-bowl");
  await addIngredient(h.db, "paneer");
  libraryCover = await approveFixture(h.db, store, { candidateKey: "commons:lib" });
  await approveFixture(h.db, store, { subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:paneer" });
  library = await readLibraryManifest(h.db);
});

describe("recipe photos", () => {
  it("shows library photos to a household with none, from the public route", async () => {
    const views = await photosOfRecipe(h.db, recipeId, "a", library);
    expect(views).toEqual([expect.objectContaining({ uid: libraryCover, scope: "library", isCover: true, url: `/library-photos/${libraryCover}/master`, thumbUrl: `/library-photos/${libraryCover}/thumb`, origin: "commons", author: "A. Person" })]);
  });

  it("lists household rows first and makes your own uploaded cover the only cover", async () => {
    await household("a", "own-cover", { isCover: true });
    const views = await photosOfRecipe(h.db, recipeId, "a", library);
    expect(views.map((v) => [v.uid, v.scope, v.isCover])).toEqual([["own-cover", "household", true], [libraryCover, "library", false]]);
  });

  it("lets the library cover beat a household candidate cover, and a household candidate cover stand when the library has none", async () => {
    await household("a", "own-candidate", { isCover: true, origin: "commons", candidateKey: "commons:mine", title: "Mine", author: "B", licence: "CC0 1.0" });
    expect((await photosOfRecipe(h.db, recipeId, "a", library)).map((v) => [v.uid, v.isCover])).toEqual([["own-candidate", false], [libraryCover, true]]);
    expect((await photosOfRecipe(h.db, recipeId, "a", EMPTY_LIBRARY_MANIFEST)).map((v) => [v.uid, v.isCover])).toEqual([["own-candidate", true]]);
  });

  it("hides a household copy of a candidate the library already has", async () => {
    await household("a", "dup", { isCover: true, origin: "commons", candidateKey: "commons:lib" });
    await household("a", "upload-no-key");
    const views = await photosOfRecipe(h.db, recipeId, "a", library);
    expect(views.map((v) => v.uid)).toEqual(["upload-no-key", libraryCover]);
    expect(views.filter((v) => v.isCover).map((v) => v.uid)).toEqual([libraryCover]);
  });

  it("never shows another household's photos", async () => {
    await household("b", "theirs", { isCover: true });
    expect((await photosOfRecipe(h.db, recipeId, "a", library)).map((v) => v.uid)).toEqual([libraryCover]);
    expect((await photosOfRecipe(h.db, recipeId, "b", library)).map((v) => v.uid)).toEqual(["theirs", libraryCover]);
  });

  it("returns only household rows for a recipe id that no longer exists", async () => {
    expect(await photosOfRecipe(h.db, 9999, "a", library)).toEqual([]);
    expect(await photosOfRecipe(h.db, recipeId, "a")).toEqual([]);
  });
});

describe("ingredient photos", () => {
  it("merges the same way", async () => {
    await h.db.insert(s.photos).values([
      { householdId: "a", ingredientSlug: "paneer", uid: "own", origin: "upload", isCover: true, sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" },
      { householdId: "a", ingredientSlug: "paneer", uid: "dup", origin: "commons", candidateKey: "commons:paneer", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" },
      { householdId: "b", ingredientSlug: "paneer", uid: "theirs", origin: "upload", isCover: true, sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" },
    ]);
    const views = await photosOfIngredient(h.db, "paneer", "a", library);
    expect(views.map((v) => [v.uid, v.scope, v.isCover])).toEqual([["own", "household", true], [library.ingredients.paneer!.cover.uid, "library", false]]);
    expect((await photosOfIngredient(h.db, "paneer", "a")).map((v) => v.uid)).toEqual(["own", "dup"]);
  });
});

describe("cover index", () => {
  it("uses the library cover, and your upload over it, and never another household's cover", async () => {
    const library_ = await photoIndex(h.db, "a", library);
    expect(library_.recipes.get("falafel-bowl")).toBe(libraryPhotoUrl(libraryCover, "thumb"));
    expect(library_.ingredients.get("paneer")).toBe(libraryPhotoUrl(library.ingredients.paneer!.cover.uid, "thumb"));
    await household("b", "theirs", { isCover: true });
    expect((await photoIndex(h.db, "a", library)).recipes.get("falafel-bowl")).toBe(libraryPhotoUrl(libraryCover, "thumb"));
    await household("a", "mine", { isCover: true });
    await h.db.insert(s.photos).values({ householdId: "a", ingredientSlug: "paneer", uid: "mine-ing", origin: "upload", isCover: true, sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" });
    const index = await photoIndex(h.db, "a", library);
    expect(index.recipes.get("falafel-bowl")).toBe("/photos/mine/thumb");
    expect(index.ingredients.get("paneer")).toBe("/photos/mine-ing/thumb");
  });

  it("keeps the library cover over a household candidate cover, and falls back to it without a library", async () => {
    await household("a", "cand", { isCover: true, origin: "openverse", candidateKey: "openverse:x" });
    expect((await photoIndex(h.db, "a", library)).recipes.get("falafel-bowl")).toBe(libraryPhotoUrl(libraryCover, "thumb"));
    expect((await photoIndex(h.db, "a")).recipes.get("falafel-bowl")).toBe("/photos/cand/thumb");
    expect([...(await photoIndex(h.db, "b")).recipes]).toEqual([]);
  });
});

describe("credits", () => {
  it("lists library credits and the household's own credited candidates, not uploads, duplicates or other households", async () => {
    await household("a", "up");
    await household("a", "dup", { origin: "commons", candidateKey: "commons:lib", title: "Dup" });
    await household("a", "mine", { origin: "openverse", candidateKey: "openverse:mine", title: "Mine", author: "M", licence: "CC BY 2.0" });
    await household("b", "theirs", { origin: "openverse", candidateKey: "openverse:t", title: "Theirs" });
    await h.db.insert(s.photos).values({ householdId: "a", ingredientSlug: "paneer", uid: "ing", origin: "commons", candidateKey: "commons:i", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02", updatedAt: "2026-11-02" });
    const rows = await creditedPhotos(h.db, "a", library);
    expect(rows.map((r) => [r.uid, r.scope, r.subjectKind, r.subjectSlug])).toEqual([
      [libraryCover, "library", "recipe", "falafel-bowl"],
      [library.ingredients.paneer!.cover.uid, "library", "ingredient", "paneer"],
      ["mine", "household", "recipe", "falafel-bowl"],
      ["ing", "household", "ingredient", "paneer"],
    ]);
    expect((await creditedPhotos(h.db, "a")).map((r) => r.uid)).toEqual(["dup", "mine", "ing"]);
  });
});
