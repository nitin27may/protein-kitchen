import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { applyRenames } from "../lib/db/renames";
import { exportHumanData, importHumanData } from "../lib/human";
import { feedbackClass, writeRecipeFeedback } from "../lib/human/feedback";
import { deletePersonalFeedbackForPerson, PERSONAL_FEEDBACK_CLASS, personalFeedbackClass, writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { personKey } from "../lib/human/routines";
import { householdFeedback, personalFeedback, planningFeedback } from "../lib/server/feedback";
import { resetCounts, resetData } from "../lib/server/reset";
import { loadData } from "../lib/data/load";
import { buildCandidates } from "../lib/planner/candidates";
import { eligible } from "../lib/planner/generate";
import type { PlanInput } from "../lib/planner/types";

let h: DbHandle;
let first: number;
let second: number;
let recipe: number;
async function fixtures(db: DbHandle["db"], shift = false) {
  if (shift) {
    await db.insert(s.people).values({ name: "Shift", sex: "other", birthDate: "2001-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] });
    await db.insert(s.recipes).values({ slug: "shift", name: "Shift", family: "bowls", kind: "recipe", mealSlots: ["lunch"], cuisine: "global", servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, fridgeDays: 2, isIndian: false, equipment: [], tags: [] });
  }
  const people = await db.insert(s.people).values(["First", "Second"].map((name) => ({
    name, sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  }))).returning();
  const [r] = await db.insert(s.recipes).values({
    slug: "feedback-bowl", name: "Feedback bowl", family: "bowls", kind: "recipe", mealSlots: ["lunch"], cuisine: "global",
    servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, fridgeDays: 2, isIndian: false, equipment: [], tags: [],
  }).returning();
  await writeRecipeFeedback(db, r!.id, { rating: 4, favourite: true, notes: "Earlier shared note." });
  return { first: people[0]!.id, second: people[1]!.id, recipe: r!.id };
}
const rows = () => h.db.select().from(s.personRecipeFeedback).orderBy(s.personRecipeFeedback.personId, s.personRecipeFeedback.recipeId);
beforeEach(async () => {
  h = await openDb();
  ({ first, second, recipe } = await fixtures(h.db));
});

describe("personal feedback and historical household preservation", () => {
  it("keeps two cooks' choices separate and never attributes earlier household ratings", async () => {
    expect((await personalFeedback(h.db, first)).get("feedback-bowl")).toMatchObject({ rating: null, favourite: false, tested: true });
    const [history] = await h.db.select().from(s.recipeFeedback);
    await writePersonalRecipeFeedback(h.db, first, recipe, { favourite: true });
    expect(await h.db.select().from(s.recipeFeedback)).toEqual([history]);
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 2 });
    expect(await rows()).toMatchObject([
      { personId: first, favourite: true, rating: null, createdByPersonId: first },
      { personId: second, favourite: false, rating: 2, createdByPersonId: second },
    ]);
    expect((await personalFeedback(h.db, first)).get("feedback-bowl")).toMatchObject({ favourite: true, rating: null });
    expect((await personalFeedback(h.db, second)).get("feedback-bowl")).toMatchObject({ favourite: false, rating: 2 });
    expect((await householdFeedback(h.db)).get("feedback-bowl")).toMatchObject({ favourite: true, rating: 4 });
    expect(await h.db.select().from(s.recipeFeedback)).toMatchObject([{
      rating: 4, favourite: true, notes: "Earlier shared note.", uid: history!.uid, createdAt: history!.createdAt,
    }]);
  });

  it("updates only submitted personal fields, keeping uid and creation time", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5, favourite: true });
    const [before] = await rows();
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: null });
    expect(await rows()).toMatchObject([{ ...before, rating: null, updatedAt: expect.any(String) }]);
    await writePersonalRecipeFeedback(h.db, first, recipe, { favourite: false });
    expect(await rows()).toMatchObject([{ uid: before!.uid, createdAt: before!.createdAt, rating: null, favourite: false }]);
    expect(await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, PERSONAL_FEEDBACK_CLASS))).toMatchObject([{
      changedAt: expect.any(String), exportedAt: null,
    }]);
  });

  it("shares tested/banned/notes without clearing anyone's personal rating", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 3 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { tested: false, banned: true, notes: "Shared method note." });
    expect((await personalFeedback(h.db, first)).get("feedback-bowl")).toEqual({ rating: 5, favourite: false, tested: false, banned: true });
    expect((await personalFeedback(h.db, second)).get("feedback-bowl")).toEqual({ rating: 3, favourite: false, tested: false, banned: true });
    expect(await h.db.select().from(s.recipeFeedback)).toMatchObject([{ status: "draft", notes: "Shared method note.", rating: 4 }]);
  });

  it("validates untrusted shapes, integer ratings, booleans and note limits before writing", async () => {
    for (const input of [null, {}, { rating: undefined }, { personId: second, favourite: true }, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: "5" }, { favourite: "yes" }, { notes: "x".repeat(2001) }]) {
      await expect(Reflect.apply(writePersonalRecipeFeedback, undefined, [h.db, first, recipe, input])).rejects.toThrow();
    }
    expect(await rows()).toEqual([]);
  });

  it("enforces rating, uid uniqueness and owner/recipe foreign keys in Postgres itself", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    const [row] = await rows();
    await expect(h.db.update(s.personRecipeFeedback).set({ rating: 6 })).rejects.toThrow();
    await expect(h.db.insert(s.personRecipeFeedback).values({ ...row!, personId: second })).rejects.toThrow();
    await expect(h.db.insert(s.personRecipeFeedback).values({ ...row!, personId: 9999, uid: "missing-person" })).rejects.toThrow();
    await expect(h.db.insert(s.personRecipeFeedback).values({ ...row!, recipeId: 9999, uid: "missing-recipe" })).rejects.toThrow();
    expect(await rows()).toEqual([row]);
  });

  it("adds the migration to pre-existing data without changing legacy feedback or inventing an author", async () => {
    await h.client.exec("DROP TABLE person_recipe_feedback");
    const history = await feedbackClass.exportFiles(h.db);
    await h.client.exec(await readFile("db/postgres-migrations/0004_puzzling_slyde.sql", "utf8"));
    expect(await rows()).toEqual([]);
    expect(await feedbackClass.exportFiles(h.db)).toEqual(history);
  });

  it.each([
    ["person_recipe_feedback", "INSERT", undefined],
    ["sync_state", "INSERT", "NEW.data_class = 'personal-recipe-feedback'"],
    ["recipe_feedback", "UPDATE", undefined],
    ["sync_state", "UPDATE", "NEW.data_class = 'recipe-feedback'"],
  ])("rolls personal, household and sync changes back on %s %s failure", async (table, operation, when) => {
    const history = await h.db.select().from(s.recipeFeedback);
    const sync = await h.db.select().from(s.syncState);
    await h.failWrite(table, operation, "feedback_failure", when);
    await expect(writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5, favourite: true })).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect(await h.db.select().from(s.recipeFeedback)).toEqual(history);
    expect(await h.db.select().from(s.syncState)).toEqual(sync);
  });
});

describe("shared planning uses selected eaters, not the account running the planner", () => {
  it("keeps household history only until a selected eater records a personal choice", async () => {
    expect((await planningFeedback(h.db, [first])).get("feedback-bowl")).toMatchObject({ rating: 4, favourite: true });
    await writePersonalRecipeFeedback(h.db, first, recipe, { favourite: false });
    expect((await planningFeedback(h.db, [first])).get("feedback-bowl")).toMatchObject({ rating: null, favourite: false });
    expect((await planningFeedback(h.db, [second])).get("feedback-bowl")).toMatchObject({ rating: 4, favourite: true });
    expect((await planningFeedback(h.db, [])).get("feedback-bowl")).toMatchObject({ rating: 4 });
  });

  it("uses any selected favourite, averages positive ratings and never averages away a rejection", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5, favourite: true });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 3 });
    expect((await planningFeedback(h.db, [first, second])).get("feedback-bowl")).toMatchObject({ rating: 4, favourite: true });
    expect((await planningFeedback(h.db, [second])).get("feedback-bowl")).toMatchObject({ rating: 3, favourite: false });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 1 });
    expect((await planningFeedback(h.db, [first, second])).get("feedback-bowl")).toMatchObject({ rating: 1 });
    expect((await planningFeedback(h.db, [first])).get("feedback-bowl")).toMatchObject({ rating: 5 });
    expect((await planningFeedback(h.db, [second, first, first])).get("feedback-bowl")).toMatchObject({ rating: 1 });
  });

  it("includes a personal choice when no legacy household row exists", async () => {
    await h.db.delete(s.recipeFeedback);
    await writePersonalRecipeFeedback(h.db, first, recipe, { favourite: true });
    expect((await personalFeedback(h.db, first)).get("feedback-bowl")).toEqual({ favourite: true, rating: null, tested: false, banned: false });
    expect((await planningFeedback(h.db, [first])).get("feedback-bowl")).toEqual({ favourite: true, rating: null, tested: false, banned: false });
  });

  it("actually excludes a low-rated recipe only when that eater is included in generation", async () => {
    const slug = "tofu-burrito-bowl";
    await h.db.update(s.recipes).set({ slug }).where(eq(s.recipes.id, recipe));
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 2 });
    const data = loadData(process.cwd());
    const input: PlanInput = {
      dates: ["2026-10-26"], mealTypes: ["lunch"], people: [], cuisineBalance: 0.5, maxActiveMin: 120,
      pinnedRecipes: [], locked: [], seed: 1,
    };
    const own = buildCandidates(data, await planningFeedback(h.db, [first])).find((c) => c.slug === slug)!;
    const together = buildCandidates(data, await planningFeedback(h.db, [first, second])).find((c) => c.slug === slug)!;
    expect(eligible(own, "lunch", input.dates[0]!, input)).toBe(true);
    expect(eligible(together, "lunch", input.dates[0]!, input)).toBe(false);
  });
});

describe("versioned personal feedback exports", () => {
  it("exports v2 without database ids and round trips byte-for-byte with shifted person/recipe ids", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5, favourite: true });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 2 });
    const bundle = await exportHumanData(h.db);
    expect(bundle.manifest.version).toBe(2);
    const file = bundle.files[`personal-feedback/${personKey("First", "2000-01-01")}.json`]!;
    expect(file).not.toContain("2000-01-01");
    expect(file).not.toMatch(/"(?:person_id|recipe_id|created_by_person_id|name)"/);
    const target = await openDb();
    const ids = await fixtures(target.db, true);
    const report = await importHumanData(target.db, bundle);
    expect(report.skipped).toEqual([]);
    expect(report.imported[PERSONAL_FEEDBACK_CLASS]).toBe(2);
    expect(await exportHumanData(target.db)).toEqual(bundle);
    await importHumanData(target.db, bundle);
    expect(await exportHumanData(target.db)).toEqual(bundle);
    expect(await target.db.select().from(s.personRecipeFeedback).where(eq(s.personRecipeFeedback.personId, ids.first)))
      .toMatchObject([{ rating: 5, favourite: true }]);
  });

  it("imports a historical v1 bundle without creating or claiming personal feedback", async () => {
    const bundle = await exportHumanData(h.db);
    const target = await openDb();
    await fixtures(target.db, true);
    expect((await importHumanData(target.db, { ...bundle, manifest: { ...bundle.manifest, version: 1 } })).skipped).toEqual([]);
    expect(await target.db.select().from(s.personRecipeFeedback)).toEqual([]);
    expect((await exportHumanData(target.db)).files).toEqual(bundle.files);
    expect(await target.db.select().from(s.recipeFeedback)).toMatchObject([{ rating: 4, favourite: true }]);
  });

  it("refuses future versions before changing anything", async () => {
    const before = await exportHumanData(h.db);
    await expect(Reflect.apply(importHumanData, undefined, [h.db, { ...before, manifest: { ...before.manifest, version: 999 } }]))
      .rejects.toThrow("Unsupported human-data export version");
    expect(await exportHumanData(h.db)).toEqual(before);
  });

  it("follows slug renames and reports unmatched people and missing recipes", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { favourite: true });
    const bundle = await exportHumanData(h.db);
    const target = await openDb();
    const ids = await fixtures(target.db);
    await target.db.delete(s.people).where(eq(s.people.id, ids.second));
    await target.db.update(s.recipes).set({ slug: "renamed-bowl" }).where(eq(s.recipes.id, ids.recipe));
    const report = await importHumanData(target.db, bundle, { renames: { "feedback-bowl": "renamed-bowl" } });
    expect(report.imported[PERSONAL_FEEDBACK_CLASS]).toBe(1);
    expect(report.skipped).toContain(`personal-feedback/${personKey("Second", "2000-01-01")}.json`);
    await target.db.delete(s.recipes);
    const missing = await importHumanData(target.db, bundle);
    expect(missing.skipped).toContain(`personal-feedback/${personKey("First", "2000-01-01")}.json#feedback-bowl`);
  });

  it("refuses a mismatched file/person key and rolls back imports after a later write fails", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { favourite: true });
    await writePersonalRecipeFeedback(h.db, second, recipe, { favourite: false });
    const files = await personalFeedbackClass.exportFiles(h.db);
    const path = Object.keys(files)[0]!;
    await expect(personalFeedbackClass.importFiles(h.db, { "personal-feedback/mismatch.json": files[path]! }, { resolveRecipeId: async () => recipe }))
      .rejects.toThrow("does not match");
    const target = await openDb();
    const ids = await fixtures(target.db);
    await target.failWrite("person_recipe_feedback", "INSERT", "import_failure", `NEW.person_id = ${ids.second}`);
    await expect(personalFeedbackClass.importFiles(target.db, files, { resolveRecipeId: async () => ids.recipe })).rejects.toThrow();
    expect(await target.db.select().from(s.personRecipeFeedback)).toEqual([]);
  });

  it("refuses to merge or attribute feedback when profile keys are ambiguous", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    const files = await personalFeedbackClass.exportFiles(h.db);
    await h.db.insert(s.people).values({
      name: " First ", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    });
    await expect(personalFeedbackClass.exportFiles(h.db)).rejects.toThrow("ambiguous profile keys");
    expect(await personalFeedbackClass.importFiles(h.db, files, { resolveRecipeId: async () => recipe })).toEqual({
      imported: 0, skipped: Object.keys(files),
    });
    expect(await rows()).toMatchObject([{ personId: first, rating: 5 }]);
  });
});

describe("renames, profile deletion and resets", () => {
  it("moves each person's feedback independently and retains conflicting source history", async () => {
    const [other] = await h.db.insert(s.recipes).values({
      slug: "renamed-bowl", name: "Renamed bowl", family: "bowls", kind: "recipe", mealSlots: ["lunch"], cuisine: "global",
      servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, fridgeDays: 2, isIndian: false, equipment: [], tags: [],
    }).returning();
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 2 });
    await writePersonalRecipeFeedback(h.db, second, other!.id, { rating: 4 });
    await applyRenames(h.db, { "feedback-bowl": "renamed-bowl" });
    expect(await rows()).toMatchObject([
      { personId: first, recipeId: other!.id, rating: 5 },
      { personId: second, recipeId: recipe, rating: 2 },
      { personId: second, recipeId: other!.id, rating: 4 },
    ]);
    expect(await personalFeedbackClass.hasRecipeData!(h.db, recipe)).toBe(true);
    expect(await personalFeedbackClass.moveRecipe!(h.db, recipe, other!.id)).toBe(false);
    expect(await h.db.select().from(s.recipes).where(eq(s.recipes.id, recipe))).toHaveLength(1);
    expect(Object.keys(await personalFeedbackClass.exportFiles(h.db))).toHaveLength(2);
  });

  it.each(["ratings", "profiles", "all"] as const)("clears personal choices and marks exports on %s reset", async (scope) => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    expect((await resetCounts(h.db)).ratings).toBe(2);
    await resetData(h.db, scope);
    expect(await rows()).toEqual([]);
    expect((await exportHumanData(h.db)).manifest.tables[PERSONAL_FEEDBACK_CLASS]?.count).toBe(0);
    expect(await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, PERSONAL_FEEDBACK_CLASS))).toHaveLength(1);
    if (scope === "profiles") expect((await householdFeedback(h.db)).get("feedback-bowl")?.rating).toBe(4);
  });

  it("deletes one person's feedback without removing another person's or the shared history", async () => {
    await writePersonalRecipeFeedback(h.db, first, recipe, { rating: 5 });
    await writePersonalRecipeFeedback(h.db, second, recipe, { rating: 2 });
    await deletePersonalFeedbackForPerson(h.db, first);
    expect(await rows()).toMatchObject([{ personId: second, rating: 2 }]);
    expect(await h.db.select().from(s.personRecipeFeedback).where(and(eq(s.personRecipeFeedback.personId, first), eq(s.personRecipeFeedback.recipeId, recipe)))).toEqual([]);
    expect((await householdFeedback(h.db)).get("feedback-bowl")?.rating).toBe(4);
  });
});
