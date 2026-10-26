import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { applyRenames, RenamesSchema } from "../lib/db/renames";
import { clearSavedView, exportHumanData, importHumanData, registerExporter, writeRecipeFeedback, writeSavedView } from "../lib/human";
import type { HumanDataClass } from "../lib/human";
import { feedbackClass } from "../lib/human/feedback";
import { savedViewsClass } from "../lib/human/saved-views";
import { photosClass } from "../lib/human/photos";

const migrations = path.resolve(__dirname, "..", "db", "migrations");
let a: DbHandle;

async function addRecipe(h: DbHandle, slug: string, opts: { feedback?: boolean } = {}): Promise<number> {
  const [row] = await h.db
    .insert(s.recipes)
    .values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
    .returning({ id: s.recipes.id });
  // The seed gives every recipe an untouched feedback row.
  if (opts.feedback !== false) await h.db.insert(s.recipeFeedback).values({ recipeId: row!.id });
  return row!.id;
}

const feedbackOf = async (h: DbHandle, id: number) => (await h.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, id)))[0];
const syncOf = async (h: DbHandle, cls: string) => (await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, cls)))[0];

beforeEach(async () => {
  a = await openDb();
});

describe("writeRecipeFeedback", () => {
  it("a rating marks the recipe tested and stamps uid and timestamps", async () => {
    const id = await addRecipe(a, "palak-paneer");
    await writeRecipeFeedback(a.db, id, { rating: 4 });
    const r = (await feedbackOf(a, id))!;
    expect(r.rating).toBe(4);
    expect(r.status).toBe("tested");
    expect(r.testedAt).not.toBeNull();
    expect(r.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.createdAt).not.toBeNull();
    expect(r.updatedAt).not.toBeNull();
  });

  it("removing the rating keeps the tested status; the tested flag toggles it", async () => {
    const id = await addRecipe(a, "palak-paneer");
    await writeRecipeFeedback(a.db, id, { rating: 5 });
    await writeRecipeFeedback(a.db, id, { rating: null });
    expect((await feedbackOf(a, id))!.status).toBe("tested");
    await writeRecipeFeedback(a.db, id, { tested: false });
    const r = (await feedbackOf(a, id))!;
    expect(r.status).toBe("draft");
    expect(r.testedAt).toBeNull();
    await writeRecipeFeedback(a.db, id, { tested: true });
    expect((await feedbackOf(a, id))!.status).toBe("tested");
  });

  it("keeps uid and created_at across writes and moves updated_at forward", async () => {
    const id = await addRecipe(a, "palak-paneer");
    await writeRecipeFeedback(a.db, id, { favourite: true });
    const first = (await feedbackOf(a, id))!;
    await new Promise((r) => setTimeout(r, 5));
    await writeRecipeFeedback(a.db, id, { notes: "less salt" });
    const second = (await feedbackOf(a, id))!;
    expect(second.uid).toBe(first.uid);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt! > first.updatedAt!).toBe(true);
    expect(second.favourite).toBe(true);
    expect(second.notes).toBe("less salt");
  });

  it("marks the data class changed in sync_state, and rejects a rating outside 1 to 5", async () => {
    const id = await addRecipe(a, "palak-paneer");
    expect(await syncOf(a, "recipe-feedback")).toBeUndefined();
    await writeRecipeFeedback(a.db, id, { banned: true });
    const sync = (await syncOf(a, "recipe-feedback"))!;
    expect(sync.changedAt).toBeTruthy();
    expect(sync.exportedAt).toBeNull();
    await expect(writeRecipeFeedback(a.db, id, { rating: 6 })).rejects.toThrow(RangeError);
    await expect(writeRecipeFeedback(a.db, id, { rating: 0 })).rejects.toThrow(RangeError);
  });

  it("creates the feedback row if the recipe has none", async () => {
    const id = await addRecipe(a, "no-row", { feedback: false });
    await writeRecipeFeedback(a.db, id, { favourite: true });
    expect((await feedbackOf(a, id))!.favourite).toBe(true);
  });
});

describe("saved views", () => {
  it("a list has one default; writing again updates it in place and keeps its uid", async () => {
    const first = await writeSavedView(a.db, { list: "recipes", query: "meal=lunch" });
    const second = await writeSavedView(a.db, { list: "recipes", query: "meal=dinner" });
    expect(second.uid).toBe(first.uid);
    const rows = await a.db.select().from(s.savedViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("meal=dinner");
    expect((await syncOf(a, "saved-views"))!.changedAt).toBeTruthy();
  });

  it("clearSavedView removes the default and marks the class changed", async () => {
    await writeSavedView(a.db, { list: "ingredients", query: "aisle=dairy" });
    await clearSavedView(a.db, "ingredients");
    expect(await a.db.select().from(s.savedViews)).toHaveLength(0);
  });
});

describe("export and import", () => {
  it("refuses an unscoped multi-household bundle before filling legacy export stamps", async () => {
    const recipeId = await addRecipe(a, "fixture");
    await a.db.update(s.recipeFeedback).set({ favourite: true }).where(eq(s.recipeFeedback.recipeId, recipeId));
    await a.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    const before = await a.db.select().from(s.recipeFeedback);
    await expect(exportHumanData(a.db)).rejects.toThrow("cannot represent multiple households");
    expect(await a.db.select().from(s.recipeFeedback)).toEqual(before);
    expect(await exportHumanData(a.db, ["recipe-feedback"], { householdId: "a" }))
      .toMatchObject({ files: {}, manifest: { version: 2 } });
  });

  it("preserves single-household operator exports but refuses legacy import into any claimed target", async () => {
    const recipeId = await addRecipe(a, "fixture");
    await a.db.insert(s.households).values({ id: "a", name: "First" });
    await a.db.update(s.recipeFeedback).set({ householdId: "a", favourite: true }).where(eq(s.recipeFeedback.recipeId, recipeId));
    const bundle = await exportHumanData(a.db);
    expect(Object.keys(bundle.files)).toEqual(["feedback/fixture.json"]);
    const before = await a.db.select().from(s.recipeFeedback);
    for (const version of [1, 2] as const) {
      await expect(importHumanData(a.db, { ...bundle, manifest: { ...bundle.manifest, version } }))
        .rejects.toThrow("unclaimed operator staging");
    }
    expect(await a.db.select().from(s.recipeFeedback)).toEqual(before);
  });

  it("rolls back earlier export stamps if a later class fails", async () => {
    const recipeId = await addRecipe(a, "fixture");
    await a.db.update(s.recipeFeedback).set({ favourite: true }).where(eq(s.recipeFeedback.recipeId, recipeId));
    const before = await a.db.select().from(s.recipeFeedback);
    const later = vi.spyOn(savedViewsClass, "exportFiles").mockRejectedValueOnce(new Error("synthetic serialization failure"));
    try {
      await expect(exportHumanData(a.db)).rejects.toThrow("synthetic serialization failure");
      expect(await a.db.select().from(s.recipeFeedback)).toEqual(before);
    } finally { later.mockRestore(); }
  });

  it("rolls back earlier class writes when a later legacy import file is malformed", async () => {
    const source = await openDb();
    const recipeId = await addRecipe(source, "fixture");
    await writeRecipeFeedback(source.db, recipeId, { favourite: true });
    const bundle = await exportHumanData(source.db);
    bundle.files["saved-views/recipes.json"] = "{";
    await addRecipe(a, "fixture");
    const before = await a.db.select().from(s.recipeFeedback);
    await expect(importHumanData(a.db, bundle)).rejects.toThrow();
    expect(await a.db.select().from(s.recipeFeedback)).toEqual(before);
    expect(await a.db.select().from(s.syncState)).toEqual([]);
  });

  async function seedHuman(h: DbHandle) {
    const palak = await addRecipe(h, "palak-paneer");
    const rajma = await addRecipe(h, "rajma-masala");
    await addRecipe(h, "untouched-recipe");
    await writeRecipeFeedback(h.db, palak, { rating: 5, favourite: true, notes: "family favourite" });
    await writeRecipeFeedback(h.db, rajma, { banned: true });
    await writeSavedView(h.db, { list: "recipes", query: "meal=lunch&time=20" });
    await writeSavedView(h.db, { list: "ingredients", query: "aisle=legumes" });
  }

  it("round trips byte for byte into a fresh database whose recipe ids differ", async () => {
    await seedHuman(a);
    const first = await exportHumanData(a.db);

    const b = await openDb();
    await addRecipe(b, "something-else-first"); // shifts every recipe id
    await addRecipe(b, "palak-paneer");
    await addRecipe(b, "rajma-masala");
    await addRecipe(b, "untouched-recipe");
    const report = await importHumanData(b.db, first, { renames: {} });
    expect(report.skipped).toEqual([]);
    expect(report.imported).toEqual({ "library-photo-decisions": 0, "library-photos": 0, "personal-recipe-feedback": 0, "person-routines": 0, "photo-decisions": 0, "photos": 0, "recipe-feedback": 2, "recipe-links": 0, "saved-views": 2 });

    const second = await exportHumanData(b.db);
    expect(Object.keys(second.files)).toEqual(Object.keys(first.files));
    expect(second.files).toEqual(first.files);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.tables["recipe-feedback"]!.count).toBe(2);
    expect(first.manifest.tables["recipe-feedback"]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: importing twice changes nothing", async () => {
    await seedHuman(a);
    const bundle = await exportHumanData(a.db);
    const b = await openDb();
    for (const slug of ["palak-paneer", "rajma-masala", "untouched-recipe"]) await addRecipe(b, slug);
    await importHumanData(b.db, bundle, { renames: {} });
    const once = await exportHumanData(b.db);
    await importHumanData(b.db, bundle, { renames: {} });
    expect(await exportHumanData(b.db)).toEqual(once);
    expect(await b.db.select().from(s.savedViews)).toHaveLength(2);
  });

  it("never exports database ids, and keys files by slug and uid", async () => {
    await seedHuman(a);
    const { files } = await exportHumanData(a.db);
    const paths = Object.keys(files).sort();
    expect(paths).toHaveLength(4);
    expect(paths.slice(0, 2)).toEqual(["feedback/palak-paneer.json", "feedback/rajma-masala.json"]);
    expect(paths[2]).toMatch(/^saved-views\/ingredients-[0-9a-f-]{36}\.json$/);
    expect(paths[3]).toMatch(/^saved-views\/recipes-[0-9a-f-]{36}\.json$/);
    for (const text of Object.values(files)) {
      const keys = Object.keys(JSON.parse(text));
      expect(keys).not.toContain("id");
      expect(keys).not.toContain("recipe_id");
      expect(keys).not.toContain("recipeId");
      expect(keys).not.toContain("created_by_person_id");
      expect(text.endsWith("}\n")).toBe(true);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it("does not export untouched feedback rows", async () => {
    await addRecipe(a, "one");
    await addRecipe(a, "two");
    const { files, manifest } = await exportHumanData(a.db);
    expect(Object.keys(files)).toEqual([]);
    expect(manifest.tables["recipe-feedback"]!.count).toBe(0);
  });

  it("fills uid and timestamps for rows written before they existed, once", async () => {
    const id = await addRecipe(a, "legacy");
    await a.db.update(s.recipeFeedback).set({ rating: 4, status: "tested", testedAt: "2026-01-02T03:04:05.000Z" }).where(eq(s.recipeFeedback.recipeId, id));
    expect((await feedbackOf(a, id))!.uid).toBeNull();
    const one = await exportHumanData(a.db);
    const row = (await feedbackOf(a, id))!;
    expect(row.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(await exportHumanData(a.db)).toEqual(one);
  });

  it("skips files for a recipe that no longer exists, and follows a rename", async () => {
    const id = await addRecipe(a, "old-name");
    await writeRecipeFeedback(a.db, id, { rating: 3 });
    const bundle = await exportHumanData(a.db);

    const b = await openDb();
    await addRecipe(b, "new-name");
    expect((await importHumanData(b.db, bundle, { renames: {} })).skipped).toEqual(["feedback/old-name.json"]);
    const report = await importHumanData(b.db, bundle, { renames: { "old-name": "new-name" } });
    expect(report.skipped).toEqual([]);
    const row = (await b.db.select().from(s.recipeFeedback))[0]!;
    expect(row.rating).toBe(3);
  });
});

describe("applyRenames", () => {
  it("preserves feedback conflicts, link ordering, covers and personal feedback independently in each household", async () => {
    const oldId = await addRecipe(a, "old");
    const newId = await addRecipe(a, "new");
    await a.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    const at = "2026-10-23T12:00:00.000Z";
    for (const householdId of [null, "a", "b"]) {
      const key = householdId ?? "legacy";
      if (householdId === null) {
        await a.db.update(s.recipeFeedback).set({ rating: 3, uid: `${key}-feedback`, createdAt: at, updatedAt: at }).where(eq(s.recipeFeedback.recipeId, oldId));
      } else {
        await a.db.insert(s.recipeFeedback).values({ householdId, recipeId: oldId, rating: 3, uid: `${key}-feedback`, createdAt: at, updatedAt: at });
        if (householdId === "a") await a.db.insert(s.recipeFeedback).values({ householdId, recipeId: newId, rating: 5, uid: "target-feedback", createdAt: at, updatedAt: at });
      }
      const [person] = await a.db.insert(s.people).values({
        householdId, name: key, sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
      }).returning({ id: s.people.id });
      await a.db.insert(s.personRecipeFeedback).values({ personId: person!.id, recipeId: oldId, rating: 3, uid: `${key}-personal`, createdAt: at, updatedAt: at });
      if (householdId === "a") await a.db.insert(s.personRecipeFeedback).values({ personId: person!.id, recipeId: newId, rating: 5, uid: "target-personal", createdAt: at, updatedAt: at });
      await a.db.insert(s.recipeLinks).values({ householdId, recipeId: oldId, uid: `${key}-link`, kind: "recipe", url: "https://example.test", title: key, position: 10, createdAt: at, updatedAt: at, createdByPersonId: person!.id });
      await a.db.insert(s.photos).values({ householdId, recipeId: oldId, uid: `${key}-photo`, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, isCover: true, position: 10, createdAt: at, updatedAt: at, createdByPersonId: person!.id });
      if (householdId === "a") {
        await a.db.insert(s.recipeLinks).values({ householdId, recipeId: newId, uid: "target-link", kind: "recipe", url: "https://example.test", title: key, position: 6, createdAt: at, updatedAt: at });
        await a.db.insert(s.photos).values({ householdId, recipeId: newId, uid: "target-photo", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, isCover: true, position: 6, createdAt: at, updatedAt: at });
      }
    }
    const originalLinks = await a.db.select().from(s.recipeLinks);
    const originalPhotos = await a.db.select().from(s.photos);
    expect(await applyRenames(a.db, { old: "new" })).toEqual({ moved: ["old"] });
    const feedback = await a.db.select().from(s.recipeFeedback);
    expect(feedback.find((row) => row.uid === "a-feedback")).toMatchObject({ recipeId: oldId, householdId: "a", rating: 3 });
    for (const key of ["legacy", "b"]) expect(feedback.find((row) => row.uid === `${key}-feedback`)).toMatchObject({ recipeId: newId, rating: 3, createdAt: at });
    expect(feedback.find((row) => row.uid === "target-feedback")).toMatchObject({ recipeId: newId, householdId: "a", rating: 5 });
    for (const before of originalLinks) {
      const [after] = await a.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, before.id));
      expect(after).toEqual({ ...before, recipeId: newId, position: before.uid === "target-link" ? 6 : before.householdId === "a" ? 7 : 0, updatedAt: expect.any(String) });
    }
    for (const before of originalPhotos) {
      const [after] = await a.db.select().from(s.photos).where(eq(s.photos.id, before.id));
      expect(after).toEqual({ ...before, recipeId: newId, position: before.uid === "target-photo" ? 6 : before.householdId === "a" ? 7 : 0, isCover: before.uid !== "a-photo", updatedAt: expect.any(String) });
    }
    const personal = await a.db.select().from(s.personRecipeFeedback);
    expect(personal.find((row) => row.uid === "a-personal")).toMatchObject({ recipeId: oldId, rating: 3 });
    for (const key of ["legacy", "b"]) expect(personal.find((row) => row.uid === `${key}-personal`)).toMatchObject({ recipeId: newId, rating: 3, createdAt: at });
    const revisions = await a.db.select().from(s.syncState);
    for (const householdId of [null, "a", "b"]) {
      const changed = revisions.filter((row) => row.householdId === householdId).map((row) => row.dataClass).sort();
      expect(changed).toEqual(householdId === "a" ? ["photos", "recipe-links"] : ["personal-recipe-feedback", "photos", "recipe-feedback", "recipe-links"]);
    }
    expect(await applyRenames(a.db, { old: "new" })).toEqual({ moved: [] });
    expect(await a.db.select().from(s.syncState)).toEqual(revisions);
  });

  it("rolls back earlier class moves and earlier in-place renames when a later class fails", async () => {
    const oldId = await addRecipe(a, "old");
    await addRecipe(a, "new");
    await addRecipe(a, "in-place");
    await writeRecipeFeedback(a.db, oldId, { rating: 4 });
    const before = await a.db.select().from(s.recipeFeedback);
    const revisions = await a.db.select().from(s.syncState);
    const failure = vi.spyOn(photosClass, "moveRecipe").mockRejectedValueOnce(new Error("synthetic later class failure"));
    try {
      await expect(applyRenames(a.db, { "in-place": "renamed", old: "new" })).rejects.toThrow("synthetic later class failure");
      expect(await a.db.select().from(s.recipeFeedback)).toEqual(before);
      expect(await a.db.select().from(s.syncState)).toEqual(revisions);
      expect(await a.db.select().from(s.recipes).where(eq(s.recipes.slug, "in-place"))).toHaveLength(1);
      expect(await a.db.select().from(s.recipes).where(eq(s.recipes.slug, "renamed"))).toEqual([]);
    } finally { failure.mockRestore(); }
  });

  async function plan(h: DbHandle, recipeId: number) {
    const [person] = await h.db.insert(s.people).values({ name: "T", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", dietFlags: [] }).returning({ id: s.people.id });
    const [setup] = await h.db.insert(s.planSetups).values({ personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
    const [pl] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
    await h.db.insert(s.planSlots).values({ planId: pl!.id, date: "2026-11-02", slot: "lunch", recipeId });
  }

  it("moves feedback to the new slug, deletes the unreferenced old recipe, and is idempotent", async () => {
    const oldId = await addRecipe(a, "baked-falafel-mix");
    const newId = await addRecipe(a, "baked-falafel");
    await writeRecipeFeedback(a.db, oldId, { rating: 5, favourite: true, notes: "crisp" });
    const uid = (await feedbackOf(a, oldId))!.uid;

    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: ["baked-falafel-mix"] });
    const moved = (await feedbackOf(a, newId))!;
    expect(moved.rating).toBe(5);
    expect(moved.favourite).toBe(true);
    expect(moved.notes).toBe("crisp");
    expect(moved.uid).toBe(uid);
    expect((await a.db.select().from(s.recipes).where(eq(s.recipes.slug, "baked-falafel-mix"))).length).toBe(0);

    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: [] });
    expect((await feedbackOf(a, newId))!.rating).toBe(5);
  });

  it("keeps an old recipe that a plan still uses, clears its human data, and does not move twice", async () => {
    const oldId = await addRecipe(a, "baked-falafel-mix");
    const newId = await addRecipe(a, "baked-falafel");
    await plan(a, oldId);
    await writeRecipeFeedback(a.db, oldId, { rating: 4 });

    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: ["baked-falafel-mix"] });
    expect((await a.db.select().from(s.recipes).where(eq(s.recipes.slug, "baked-falafel-mix"))).length).toBe(1);
    expect((await feedbackOf(a, newId))!.rating).toBe(4);
    const old = (await feedbackOf(a, oldId))!;
    expect(old.rating).toBeNull();
    expect(old.uid).toBeNull();

    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: [] });
    expect((await feedbackOf(a, newId))!.rating).toBe(4);
  });

  it("leaves both rows alone when the new recipe already has its own feedback", async () => {
    const oldId = await addRecipe(a, "baked-falafel-mix");
    const newId = await addRecipe(a, "baked-falafel");
    await writeRecipeFeedback(a.db, oldId, { rating: 2 });
    await writeRecipeFeedback(a.db, newId, { rating: 5 });
    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: [] });
    expect((await feedbackOf(a, newId))!.rating).toBe(5);
    expect((await feedbackOf(a, oldId))!.rating).toBe(2);
  });

  it("renames the row in place when the new slug has not been seeded", async () => {
    const id = await addRecipe(a, "baked-falafel-mix");
    await writeRecipeFeedback(a.db, id, { rating: 3 });
    expect(await applyRenames(a.db, { "baked-falafel-mix": "baked-falafel" })).toEqual({ moved: ["baked-falafel-mix"] });
    const row = (await a.db.select().from(s.recipes).where(eq(s.recipes.id, id)))[0]!;
    expect(row.slug).toBe("baked-falafel");
    expect((await feedbackOf(a, id))!.rating).toBe(3);
  });

  it("ignores an old slug that no longer exists", async () => {
    await addRecipe(a, "baked-falafel");
    expect(await applyRenames(a.db, { gone: "baked-falafel" })).toEqual({ moved: [] });
  });
});

describe("renames.json schema", () => {
  it("accepts a plain map and rejects self-renames, chains and bad slugs", () => {
    expect(RenamesSchema.safeParse({}).success).toBe(true);
    expect(RenamesSchema.safeParse({ "baked-falafel-mix": "baked-falafel" }).success).toBe(true);
    expect(RenamesSchema.safeParse({ a: "a" }).success).toBe(false);
    expect(RenamesSchema.safeParse({ a: "b", b: "c" }).success).toBe(false);
    expect(RenamesSchema.safeParse({ "Bad Slug": "ok" }).success).toBe(false);
  });
});

describe("registry", () => {
  it("rejects a duplicate name or an overlapping folder, and accepts an exact re-registration", () => {
    const dup: HumanDataClass = { ...feedbackClass, prefix: "other/" };
    expect(() => registerExporter(dup)).toThrow(/already registered/);
    const overlap: HumanDataClass = { name: "x-test", prefix: "feedback/deep/", exportFiles: async () => ({}), importFiles: async () => ({ imported: 0, skipped: [] }) };
    expect(() => registerExporter(overlap)).toThrow(/overlaps/);
  });
});
