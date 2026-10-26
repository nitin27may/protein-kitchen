import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { applyRenames } from "../lib/db/renames";
import { exportHumanData, type ExportBundle } from "../lib/human";
import { registerBuiltinClasses } from "../lib/human/builtin";
import { registeredClasses } from "../lib/human/registry";
import type { Db } from "../lib/db/client";
import { clearHouseholdFoods, FoodDataError, archiveHouseholdFood, attachFoodLabelPhoto, createHouseholdFood, deleteHouseholdFood, detachPersonFromFoods, householdFoodsClass, restoreHouseholdFood, updateHouseholdFood, type FoodScope } from "../lib/human/household-foods";
import { clearFoodLog, deleteFoodEntry, deleteFoodLogForPerson, findDanglingFoodLogSlugs, foodLogClass, logFoodEntry, markPlannedMealEaten, updateFoodEntry } from "../lib/human/food-log";
import { personKey } from "../lib/human/routines";
import { checkPhotos } from "../lib/photos/check";
import { foodLabelKeys } from "../lib/photos/keys";
import { deleteHousehold, clearHouseholdData } from "../lib/human/reset";
import { resetCounts, resetData } from "../lib/server/reset";
import { countLabelExtractions, pruneLabelExtractions, recordLabelExtraction } from "../lib/server/label-extractions";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let store: ReturnType<typeof createMemoryStore>;
const A: FoodScope = { householdId: "a", personId: 1 };
const B: FoodScope = { householdId: "b", personId: 2 };

const food = (over: Record<string, unknown> = {}) => ({
  name: "Greek yogurt 0%", brand: "Oikos", barcode: "0123456789012", state: "ready" as const, kcal: 57, proteinG: 10, carbsG: 3.6, fatG: 0.2, fibreG: null,
  per100gMicros: { calcium_mg: 110 }, notReported: ["iron_mg"], servingLabel: "3/4 cup", servingG: 175, labelBasis: "per_serving" as const,
  labelValues: { serving_g: 175, protein_g: 17.5 }, source: "LABEL" as const, fieldOrigins: { proteinG: "label" }, isDairy: true, ...over,
});
const eat = (personId: number, uid: string, over: Record<string, unknown> = {}) => ({
  personId, date: "2026-11-02", slot: "snack" as const, kind: "extra" as const, item: { type: "food" as const, householdFoodUid: uid, grams: 175 }, ...over,
});
const image = () => sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#406080" } }).jpeg().toBuffer();
/**
 * importHumanData refuses any database that has a household (legacy-bundle guard), so household-owned classes are loaded
 * through their importFiles with an explicit household, in class-name order like importHumanData does.
 */
async function importInto(db: Db, bundle: ExportBundle, householdId?: string) {
  registerBuiltinClasses();
  const imported: Record<string, number> = {};
  const skipped: string[] = [];
  for (const cls of registeredClasses().filter((c) => c.name === "food-catalog" || c.name === "food-log")) {
    const mine = Object.fromEntries(Object.entries(bundle.files).filter(([path]) => path.startsWith(cls.prefix)));
    const result = await cls.importFiles(db, mine, { resolveRecipeId: async () => undefined, householdId });
    imported[cls.name] = result.imported;
    skipped.push(...result.skipped);
  }
  return { imported, skipped };
}
const sync = async (name: string, householdId = "a") => (await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, name))).find((r) => r.householdId === householdId);

beforeEach(async () => {
  h = await openDb();
  store = createMemoryStore();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([
    { id: 1, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] },
    { id: 2, householdId: "b", name: "Ben", sex: "male", birthDate: "1984-01-02", heightCm: 180, weightKg: 80, activityLevel: "light", dietFlags: [] },
    { id: 3, householdId: "a", name: "Chen", sex: "male", birthDate: "1990-05-06", heightCm: 175, weightKg: 70, activityLevel: "light", dietFlags: [] },
  ]);
  await h.db.insert(s.ingredients).values({
    id: 1, slug: "lentils-dry", name: "Lentils", aliases: [], state: "dry", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, source: "USDA", sourceId: "x",
    aisle: "legumes", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  });
  await h.db.insert(s.recipes).values({
    id: 1, slug: "dal-tadka", name: "Dal", kind: "recipe", family: "dals", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2,
    prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  });
});

describe("household foods writer", () => {
  it("creates a confirmed food, stamps the person and marks the class changed for that household only", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    const [row] = await h.db.select().from(s.householdFoods);
    expect(row).toMatchObject({ uid, householdId: "a", createdByPersonId: 1, confirmedByPersonId: 1, fibreG: null, state: "ready", aisle: "packaged", notReported: ["iron_mg"] });
    expect(row!.confirmedAt).toBe(row!.createdAt);
    expect(await sync("food-catalog")).toBeTruthy();
    expect(await sync("food-catalog", "b")).toBeUndefined();
  });

  it("refuses structurally invalid input, a person from another household and a bad barcode", async () => {
    await expect(createHouseholdFood(h.db, A, food({ kcal: -1 }))).rejects.toMatchObject({ code: "invalid" });
    await expect(createHouseholdFood(h.db, A, food({ barcode: "12ab" }))).rejects.toMatchObject({ code: "invalid" });
    await expect(createHouseholdFood(h.db, { householdId: "a", personId: 2 }, food())).rejects.toMatchObject({ code: "person-not-found" });
    expect(await h.db.select().from(s.householdFoods)).toEqual([]);
  });

  it("keeps barcodes unique per household, allows the same barcode in another household and several foods without one", async () => {
    await createHouseholdFood(h.db, A, food());
    await expect(createHouseholdFood(h.db, A, food({ name: "Other" }))).rejects.toMatchObject({ code: "duplicate-barcode" });
    await createHouseholdFood(h.db, B, food());
    await createHouseholdFood(h.db, A, food({ name: "No code 1", barcode: null }));
    await createHouseholdFood(h.db, A, food({ name: "No code 2", barcode: null }));
    expect(await h.db.select().from(s.householdFoods)).toHaveLength(4);
    const second = await createHouseholdFood(h.db, A, food({ name: "Second", barcode: "99999999" }));
    await expect(updateHouseholdFood(h.db, A, second.uid, food({ name: "Second" }))).rejects.toMatchObject({ code: "duplicate-barcode" });
  });

  it("database constraints reject out-of-range rows written around the module", async () => {
    const base = { householdId: "a", uid: "u", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", confirmedAt: "2026-11-02T00:00:00Z", name: "x", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, labelBasis: "per_100g", source: "MANUAL" } as const;
    const bad = (over: object) => h.db.insert(s.householdFoods).values({ ...base, ...over } as never);
    await expect(bad({ proteinG: 60, carbsG: 40, fatG: 6 })).rejects.toThrow();
    await expect(bad({ kcal: -1 })).rejects.toThrow();
    await expect(bad({ barcode: "123" })).rejects.toThrow();
    await expect(bad({ servingG: 0 })).rejects.toThrow();
    await expect(bad({ labelPhotoUid: "only-uid" })).rejects.toThrow();
    await expect(bad({ state: "frozen" })).rejects.toThrow();
    await expect(bad({ source: "GUESS" })).rejects.toThrow();
    await expect(bad({ labelBasis: "per_pack" })).rejects.toThrow();
    await bad({ proteinG: 60, carbsG: 40, fatG: 5 });
  });

  it("update returns the number of past entries affected and re-confirms", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, eat(1, uid));
    await logFoodEntry(h.db, A, eat(3, uid, { date: "2026-11-03" }));
    const result = await updateHouseholdFood(h.db, { householdId: "a", personId: 3 }, uid, food({ proteinG: 11 }));
    expect(result).toEqual({ affectedEntries: 2 });
    expect(await h.db.select({ p: s.householdFoods.proteinG, by: s.householdFoods.confirmedByPersonId, c: s.householdFoods.createdByPersonId }).from(s.householdFoods)).toEqual([{ p: 11, by: 3, c: 1 }]);
  });

  it("archives and restores idempotently, refuses new entries for an archived food, and keeps old ones", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, eat(1, uid));
    expect(await archiveHouseholdFood(h.db, A, uid)).toEqual({ changed: true });
    expect(await archiveHouseholdFood(h.db, A, uid)).toEqual({ changed: false });
    await expect(logFoodEntry(h.db, A, eat(1, uid))).rejects.toMatchObject({ code: "archived" });
    expect(await h.db.select().from(s.foodLog)).toHaveLength(1);
    expect(await restoreHouseholdFood(h.db, A, uid)).toEqual({ changed: true });
    expect(await restoreHouseholdFood(h.db, A, uid)).toEqual({ changed: false });
    await logFoodEntry(h.db, A, eat(1, uid));
    await expect(archiveHouseholdFood(h.db, B, uid)).rejects.toMatchObject({ code: "not-found" });
  });

  it("deletes only a food no entry uses, and removes its label bytes after the commit", async () => {
    const used = await createHouseholdFood(h.db, A, food());
    const free = await createHouseholdFood(h.db, A, food({ name: "Free", barcode: null }));
    await logFoodEntry(h.db, A, eat(1, used.uid));
    await expect(deleteHouseholdFood(h.db, store, A, used.uid)).rejects.toMatchObject({ code: "has-entries" });
    const { labelPhotoUid } = await attachFoodLabelPhoto(h.db, store, A, free.uid, await image());
    expect(await store.list()).toEqual(Object.values(foodLabelKeys(labelPhotoUid)).sort());
    await expect(deleteHouseholdFood(h.db, store, B, free.uid)).rejects.toMatchObject({ code: "not-found" });
    expect(await deleteHouseholdFood(h.db, store, A, free.uid)).toEqual({ staleKeys: [] });
    expect(await store.list()).toEqual([]);
    expect(await h.db.select().from(s.householdFoods)).toHaveLength(1);
  });

  it("the database refuses to delete a food that entries use, even around the module", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, eat(1, uid));
    await expect(h.db.delete(s.householdFoods).where(eq(s.householdFoods.uid, uid))).rejects.toThrow();
  });
});

describe("label photos", () => {
  it("stores a WebP master and thumbnail with location data dropped, then replaces them and deletes the old bytes after commit", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    const first = await attachFoodLabelPhoto(h.db, store, A, uid, await image());
    const keys = foodLabelKeys(first.labelPhotoUid);
    expect(keys).toEqual({ master: `labels/${first.labelPhotoUid}/master.webp`, thumb: `labels/${first.labelPhotoUid}/thumb.webp` });
    expect((await sharp((await store.get(keys.master))!.bytes).metadata())).toMatchObject({ format: "webp", width: 2048 });
    expect((await h.db.select().from(s.householdFoods))[0]).toMatchObject({ labelPhotoUid: first.labelPhotoUid, labelPhotoSha256: first.sha256 });
    const second = await attachFoodLabelPhoto(h.db, store, A, uid, await image());
    expect(second.labelPhotoUid).not.toBe(first.labelPhotoUid);
    expect(second.staleKeys).toEqual([]);
    expect(await store.list()).toEqual(Object.values(foodLabelKeys(second.labelPhotoUid)).sort());
  });

  it("deletes the new blobs when the transaction fails, and keeps the old photo", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    const first = await attachFoodLabelPhoto(h.db, store, A, uid, await image());
    await h.failWrite("household_foods", "UPDATE", "boom_label");
    await expect(attachFoodLabelPhoto(h.db, store, A, uid, await image())).rejects.toThrow();
    expect(await store.list()).toEqual(Object.values(foodLabelKeys(first.labelPhotoUid)).sort());
    expect((await h.db.select().from(s.householdFoods))[0]!.labelPhotoUid).toBe(first.labelPhotoUid);
  });

  it("refuses a food from another household and leaves no blob, refuses a non-image", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await expect(attachFoodLabelPhoto(h.db, store, B, uid, await image())).rejects.toMatchObject({ code: "not-found" });
    expect(await store.list()).toEqual([]);
    await expect(attachFoodLabelPhoto(h.db, store, A, uid, new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("photos:check sees label orphans and missing files", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    const { labelPhotoUid } = await attachFoodLabelPhoto(h.db, store, A, uid, await image());
    expect(await checkPhotos(h.db, store)).toEqual({ orphans: [], missing: [] });
    await store.put("labels/stray/master.webp", new Uint8Array([1]), "image/webp");
    await store.delete(foodLabelKeys(labelPhotoUid).thumb);
    expect(await checkPhotos(h.db, store)).toEqual({ orphans: ["labels/stray/master.webp"], missing: [{ uid: labelPhotoUid, keys: [foodLabelKeys(labelPhotoUid).thumb] }] });
  });
});

describe("food log writer", () => {
  it("logs recipe, ingredient and food items as amounts only", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "lunch", kind: "planned", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1.5 } });
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 40 }, displayQty: 3, displayUnit: "tbsp" });
    await logFoodEntry(h.db, A, eat(1, uid));
    const rows = await h.db.select().from(s.foodLog).orderBy(s.foodLog.id);
    expect(rows.map((r) => [r.recipeSlug, r.servings, r.ingredientSlug, r.householdFoodId !== null, r.grams])).toEqual([["dal-tadka", 1.5, null, false, null], [null, null, "lentils-dry", false, 40], [null, null, null, true, 175]]);
    expect(Object.keys(rows[0]!).filter((k) => /kcal|protein|carb|fat/i.test(k))).toEqual([]);
    expect(await sync("food-log")).toBeTruthy();
  });

  it("enforces exactly one item in the database", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    const [f] = await h.db.select({ id: s.householdFoods.id }).from(s.householdFoods).where(eq(s.householdFoods.uid, uid));
    const base = { householdId: "a", personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" } as const;
    const put = (over: object, n: number) => h.db.insert(s.foodLog).values({ ...base, uid: `e${n}`, ...over } as never);
    await expect(put({}, 1)).rejects.toThrow();
    await expect(put({ recipeSlug: "dal-tadka", servings: 1, ingredientSlug: "lentils-dry", grams: 10 }, 2)).rejects.toThrow();
    await expect(put({ recipeSlug: "dal-tadka", servings: 1, householdFoodId: f!.id, grams: 10 }, 3)).rejects.toThrow();
    await expect(put({ recipeSlug: "dal-tadka" }, 4)).rejects.toThrow();
    await expect(put({ ingredientSlug: "lentils-dry", servings: 1 }, 5)).rejects.toThrow();
    await expect(put({ ingredientSlug: "lentils-dry", grams: 0 }, 6)).rejects.toThrow();
    await expect(put({ householdFoodId: f!.id }, 7)).rejects.toThrow();
    await put({ householdFoodId: f!.id, grams: 10 }, 8);
    await put({ recipeSlug: "dal-tadka", servings: 1 }, 9);
    await expect(put({ recipeSlug: "x", servings: 1, slot: "brunch" }, 10)).rejects.toThrow();
    await expect(put({ recipeSlug: "x", servings: 1, kind: "maybe" }, 11)).rejects.toThrow();
  });

  it("refuses another household's food, person, plan and entry everywhere", async () => {
    const foreign = await createHouseholdFood(h.db, B, food({ barcode: null }));
    const mine = await createHouseholdFood(h.db, A, food({ barcode: null }));
    await expect(logFoodEntry(h.db, A, eat(1, foreign.uid))).rejects.toMatchObject({ code: "not-found" });
    await expect(logFoodEntry(h.db, A, eat(2, mine.uid))).rejects.toMatchObject({ code: "person-not-found" });
    await expect(logFoodEntry(h.db, { householdId: "a", personId: 2 }, eat(1, mine.uid))).rejects.toMatchObject({ code: "person-not-found" });
    await expect(logFoodEntry(h.db, B, eat(2, mine.uid))).rejects.toMatchObject({ code: "not-found" });
    const [setup] = await h.db.insert(s.planSetups).values({ householdId: "b", personIds: [2], startDate: "2026-11-02", endDate: "2026-11-02", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: "2026-11-02T00:00:00Z" }).returning();
    const [plan] = await h.db.insert(s.plans).values({ householdId: "b", setupId: setup!.id, seed: 1, createdAt: "2026-11-02T00:00:00Z" }).returning();
    await expect(logFoodEntry(h.db, A, eat(1, mine.uid, { planId: plan!.id }))).rejects.toMatchObject({ code: "plan-not-found" });
    const { uid } = await logFoodEntry(h.db, A, eat(1, mine.uid));
    await expect(updateFoodEntry(h.db, B, uid, { date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: foreign.uid, grams: 5 } })).rejects.toMatchObject({ code: "not-found" });
    await expect(updateFoodEntry(h.db, A, uid, { date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: foreign.uid, grams: 5 } })).rejects.toMatchObject({ code: "not-found" });
    expect(await deleteFoodEntry(h.db, B, uid)).toBe(false);
    expect(await h.db.select().from(s.foodLog)).toHaveLength(1);
  });

  it("the database itself refuses a cross-household food or person reference", async () => {
    const foreign = await createHouseholdFood(h.db, B, food({ barcode: null }));
    const [f] = await h.db.select({ id: s.householdFoods.id }).from(s.householdFoods).where(eq(s.householdFoods.uid, foreign.uid));
    const row = { householdId: "a", date: "2026-11-02", slot: "lunch", kind: "extra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" } as const;
    await expect(h.db.insert(s.foodLog).values({ ...row, uid: "x", personId: 1, householdFoodId: f!.id, grams: 5 })).rejects.toThrow();
    await expect(h.db.insert(s.foodLog).values({ ...row, uid: "y", personId: 2, recipeSlug: "dal-tadka", servings: 1 })).rejects.toThrow();
  });

  it("updates and deletes an entry and marks the class changed", async () => {
    const { uid } = await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } });
    await updateFoodEntry(h.db, A, uid, { date: "2026-11-03", slot: "dinner", kind: "swap", plannedRecipeSlug: "dal-tadka", plannedServings: 1, item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 80 }, note: " felt like it " });
    expect((await h.db.select().from(s.foodLog))[0]).toMatchObject({ date: "2026-11-03", slot: "dinner", kind: "swap", recipeSlug: null, servings: null, ingredientSlug: "lentils-dry", grams: 80, note: "felt like it", personId: 1 });
    expect(await deleteFoodEntry(h.db, A, uid)).toBe(true);
    expect(await deleteFoodEntry(h.db, A, uid)).toBe(false);
    await expect(updateFoodEntry(h.db, A, uid, { date: "2026-11-03", slot: "dinner", kind: "swap", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } })).rejects.toMatchObject({ code: "not-found" });
  });

  it("rolls back the entry and the sync mark together", async () => {
    await h.failWrite("sync_state", "INSERT", "boom_sync");
    await expect(logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } })).rejects.toThrow();
    expect(await h.db.select().from(s.foodLog)).toEqual([]);
  });
});

describe("markPlannedMealEaten", () => {
  async function plan(householdId: string, personId: number) {
    const [setup] = await h.db.insert(s.planSetups).values({ householdId, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-02", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: "2026-11-02T00:00:00Z" }).returning();
    const [p] = await h.db.insert(s.plans).values({ householdId, setupId: setup!.id, seed: 1, createdAt: "2026-11-02T00:00:00Z" }).returning();
    const [slot] = await h.db.insert(s.planSlots).values({ planId: p!.id, date: "2026-11-02", slot: "lunch", recipeId: 1 }).returning();
    await h.db.insert(s.planSlotPortions).values({ planSlotId: slot!.id, personId, servings: 1.5 });
    return { planId: p!.id, slotId: slot!.id };
  }

  it("copies recipe, servings and plan, and locks the slot in the same transaction", async () => {
    const { planId, slotId } = await plan("a", 1);
    const first = await markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 1 });
    expect(first.created).toBe(true);
    expect((await h.db.select().from(s.foodLog))[0]).toMatchObject({ kind: "planned", recipeSlug: "dal-tadka", servings: 1.5, plannedRecipeSlug: "dal-tadka", plannedServings: 1.5, planId, date: "2026-11-02", slot: "lunch" });
    expect((await h.db.select().from(s.planSlots))[0]!.locked).toBe(true);
    expect(await markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 1 })).toMatchObject({ created: false, uid: first.uid });
    expect(await h.db.select().from(s.foodLog)).toHaveLength(1);
  });

  it("takes an override of servings, refuses a person with no portion, and another household's slot", async () => {
    const { slotId } = await plan("a", 1);
    await expect(markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 3 })).rejects.toMatchObject({ code: "not-planned" });
    await markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 3, servings: 1 });
    expect((await h.db.select().from(s.foodLog))[0]).toMatchObject({ servings: 1, plannedServings: 1 });
    await expect(markPlannedMealEaten(h.db, B, { planSlotId: slotId, personId: 2 })).rejects.toMatchObject({ code: "plan-not-found" });
    const other = await plan("b", 2);
    await expect(markPlannedMealEaten(h.db, A, { planSlotId: other.slotId, personId: 1 })).rejects.toMatchObject({ code: "plan-not-found" });
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, other.slotId)))[0]!.locked).toBe(false);
  });

  it("rolls the lock back if the entry fails", async () => {
    const { slotId } = await plan("a", 1);
    await h.failWrite("food_log", "INSERT", "boom_log");
    await expect(markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 1 })).rejects.toThrow();
    expect((await h.db.select().from(s.planSlots))[0]!.locked).toBe(false);
  });

  it("a deleted plan keeps the entry with a null plan", async () => {
    const { planId, slotId } = await plan("a", 1);
    await markPlannedMealEaten(h.db, A, { planSlotId: slotId, personId: 1 });
    await h.db.delete(s.planSlotPortions);
    await h.db.delete(s.planSlots);
    await h.db.delete(s.plans).where(eq(s.plans.id, planId));
    expect((await h.db.select().from(s.foodLog))[0]!.planId).toBeNull();
  });
});

describe("export and import", () => {
  async function seed() {
    const yogurt = await createHouseholdFood(h.db, A, food());
    const { labelPhotoUid } = await attachFoodLabelPhoto(h.db, store, A, yogurt.uid, await image());
    const bar = await createHouseholdFood(h.db, A, food({ name: "Bar", barcode: null, fibreG: 4, state: "dry", servingMl: 30, densityGPerMl: 1.1, pieceLabel: "bar", pieceG: 40 }));
    await archiveHouseholdFood(h.db, A, bar.uid);
    await createHouseholdFood(h.db, B, food({ name: "Foreign" }));
    await logFoodEntry(h.db, A, eat(1, yogurt.uid));
    await logFoodEntry(h.db, A, eat(3, yogurt.uid, { date: "2026-12-01" }));
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-05", slot: "dinner", kind: "swap", plannedRecipeSlug: "dal-tadka", plannedServings: 1, item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 60 } });
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-06", slot: "lunch", kind: "skipped", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } });
    await logFoodEntry(h.db, B, { personId: 2, date: "2026-11-02", slot: "lunch", kind: "extra", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 2 } });
    return { labelPhotoUid, yogurtUid: yogurt.uid };
  }

  it("round-trips both classes byte for byte into a fresh database, scoped to one household", async () => {
    const { labelPhotoUid, yogurtUid } = await seed();
    const exported = await exportHumanData(h.db, ["food-catalog", "food-log"], { householdId: "a" });
    const paths = Object.keys(exported.files);
    expect(paths.filter((p) => p.startsWith("household-foods/"))).toHaveLength(2);
    const asha = personKey("Asha", "1985-03-04"), chen = personKey("Chen", "1990-05-06");
    expect(paths.filter((p) => p.startsWith("food-log/"))).toEqual([`food-log/${asha}/2026-11.json`, `food-log/${chen}/2026-12.json`]);
    expect(JSON.stringify(exported.files)).not.toMatch(/\\"id\\":|household_food_id|\\"household_id/);
    const novEntries = JSON.parse(exported.files[`food-log/${asha}/2026-11.json`]!).entries;
    expect(novEntries.map((e: { kind: string }) => e.kind)).toEqual(["extra", "swap", "skipped"]);
    expect(novEntries[0].item).toEqual({ type: "food", food: yogurtUid, grams: 175 });

    const fresh = await openDb();
    await fresh.db.insert(s.households).values({ id: "a", name: "First" });
    await fresh.db.insert(s.people).values([
      { id: 11, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] },
      { id: 12, householdId: "a", name: "Chen", sex: "male", birthDate: "1990-05-06", heightCm: 175, weightKg: 70, activityLevel: "light", dietFlags: [] },
    ]);
    const report = await importInto(fresh.db, exported, "a");
    expect(report.imported).toMatchObject({ "food-catalog": 2, "food-log": 4 });
    expect(report.skipped).toEqual([]);
    expect(await exportHumanData(fresh.db, ["food-catalog", "food-log"], { householdId: "a" })).toEqual(exported);
    await importInto(fresh.db, exported, "a");
    expect(await exportHumanData(fresh.db, ["food-catalog", "food-log"], { householdId: "a" })).toEqual(exported);
    expect(await householdFoodsClass.blobs!(h.db, { householdId: "a" })).toEqual([
      { key: foodLabelKeys(labelPhotoUid).master, sha256: (await h.db.select().from(s.householdFoods).where(eq(s.householdFoods.uid, yogurtUid)))[0]!.labelPhotoSha256 },
      { key: foodLabelKeys(labelPhotoUid).thumb },
    ]);
    expect(await householdFoodsClass.blobs!(h.db, { householdId: "b" })).toEqual([]);
  });

  it("skips everything without a household, and an entry whose food or person is missing, and never overwrites another household", async () => {
    await seed();
    const exported = await exportHumanData(h.db, ["food-catalog", "food-log"], { householdId: "a" });
    const none = await importInto(h.db, exported);
    expect(none.imported).toMatchObject({ "food-catalog": 0, "food-log": 0 });
    expect(none.skipped).toHaveLength(Object.keys(exported.files).length);
    const intoB = await importInto(h.db, exported, "b");
    expect(intoB.imported).toMatchObject({ "food-catalog": 0, "food-log": 0 });
    expect(await h.db.select().from(s.householdFoods).where(eq(s.householdFoods.householdId, "b"))).toHaveLength(1);
    const only = { ...exported, files: Object.fromEntries(Object.entries(exported.files).filter(([p]) => p.startsWith("food-log/"))) };
    const fresh = await openDb();
    await fresh.db.insert(s.households).values({ id: "a", name: "First" });
    await fresh.db.insert(s.people).values({ id: 11, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] });
    const partial = await importInto(fresh.db, only, "a");
    expect(partial.imported["food-log"]).toBe(2);
    expect(partial.skipped.some((p) => p.includes("#"))).toBe(true);
    expect(partial.skipped.some((p) => p.endsWith("2026-12.json"))).toBe(true);
  });

  it("imports foods before the log (class order) and a barcode clash is skipped", async () => {
    const { registeredClasses } = await import("../lib/human/registry");
    const { registerBuiltinClasses } = await import("../lib/human/builtin");
    registerBuiltinClasses();
    const names = registeredClasses().map((c) => c.name);
    expect(names.indexOf("food-catalog")).toBeLessThan(names.indexOf("food-log"));
    await seed();
    const exported = await exportHumanData(h.db, ["food-catalog"], { householdId: "a" });
    const fresh = await openDb();
    await fresh.db.insert(s.households).values({ id: "a", name: "First" });
    await createHouseholdFood(fresh.db, { householdId: "a", personId: null }, food({ name: "Squatter" }));
    const report = await importInto(fresh.db, exported, "a");
    expect(report.imported["food-catalog"]).toBe(1);
    expect(report.skipped).toHaveLength(1);
  });
});

describe("renames", () => {
  it("an in-place rename and a rename onto an existing recipe rewrite recipe and planned slugs", async () => {
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } });
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-03", slot: "lunch", kind: "swap", plannedRecipeSlug: "dal-tadka", plannedServings: 1, item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 50 } });
    await applyRenames(h.db, { "dal-tadka": "dal-fry" });
    expect((await h.db.select({ r: s.foodLog.recipeSlug, p: s.foodLog.plannedRecipeSlug }).from(s.foodLog).orderBy(s.foodLog.id))).toEqual([{ r: "dal-fry", p: null }, { r: null, p: "dal-fry" }]);
    await h.db.insert(s.recipes).values({ id: 9, slug: "dal-final", name: "Dal", kind: "recipe", family: "dals", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1 });
    await applyRenames(h.db, { "dal-fry": "dal-final" });
    expect((await h.db.select({ r: s.foodLog.recipeSlug, p: s.foodLog.plannedRecipeSlug }).from(s.foodLog).orderBy(s.foodLog.id))).toEqual([{ r: "dal-final", p: null }, { r: null, p: "dal-final" }]);
    expect(await findDanglingFoodLogSlugs(h.db)).toEqual({ ingredients: [], recipes: [] });
  });

  it("flags log slugs the library no longer has (the library ingredient rename gap)", async () => {
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-03", slot: "snack", kind: "extra", item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 50 } });
    expect(await findDanglingFoodLogSlugs(h.db, "a")).toEqual({ ingredients: [], recipes: [] });
    await h.db.update(s.ingredients).set({ slug: "red-lentils-dry" });
    await h.db.delete(s.recipes);
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-03", slot: "snack", kind: "extra", item: { type: "recipe", recipeSlug: "gone", servings: 1 } });
    expect(await findDanglingFoodLogSlugs(h.db, "a")).toEqual({ ingredients: ["lentils-dry"], recipes: ["gone"] });
    expect(await findDanglingFoodLogSlugs(h.db, "b")).toEqual({ ingredients: [], recipes: [] });
  });
});

describe("reset, deletion and member removal", () => {
  async function fill() {
    for (const [scope, personIds] of [[A, [1, 3]], [B, [2]]] as const) {
      const { uid } = await createHouseholdFood(h.db, scope, food({ barcode: null, name: `Food ${scope.householdId}` }));
      await attachFoodLabelPhoto(h.db, store, scope, uid, await image());
      for (const personId of personIds) await logFoodEntry(h.db, scope, eat(personId, uid));
      await recordLabelExtraction(h.db, { householdId: scope.householdId, personId: personIds[0]!, model: "m", inputTokens: 10, outputTokens: 5, outcome: "success" });
    }
  }
  const count = async (table: Parameters<typeof h.db.select>[0] extends never ? never : "household_foods" | "food_log" | "label_extractions", hid: string) =>
    ((await h.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where household_id = ${hid}`)) as unknown as { rows: { n: number }[] }).rows[0]!.n;

  it("household reset scopes: profiles clear the log, everything clears foods and returns label keys, other scopes keep both", async () => {
    await fill();
    expect(await resetCounts(h.db, "a")).toMatchObject({ foods: 1, foodLog: 2 });
    await h.db.transaction(async (tx) => { await clearHouseholdData(tx, "a", "plans"); await clearHouseholdData(tx, "a", "progress"); await clearHouseholdData(tx, "a", "ratings"); });
    expect(await resetCounts(h.db, "a")).toMatchObject({ foods: 1, foodLog: 2 });
    await h.db.transaction(async (tx) => { await clearHouseholdData(tx, "a", "profiles"); });
    expect(await resetCounts(h.db, "a")).toMatchObject({ foods: 1, foodLog: 0 });
    const keys = await h.db.transaction(async (tx) => clearHouseholdData(tx, "a", "all"));
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith("labels/"))).toBe(true);
    expect(await resetCounts(h.db, "a")).toMatchObject({ foods: 0, foodLog: 0 });
    expect(await resetCounts(h.db, "b")).toMatchObject({ foods: 1, foodLog: 1 });
    expect(await count("label_extractions", "a")).toBe(1);
  });

  it("household deletion leaves nothing for the household, returns label keys and spares the other household", async () => {
    await fill();
    const keys = await h.db.transaction(async (tx) => deleteHousehold(tx, "a"));
    expect(keys.filter((k) => k.startsWith("labels/"))).toHaveLength(2);
    for (const table of ["household_foods", "food_log", "label_extractions"] as const) {
      expect(await count(table, "a"), table).toBe(0);
      expect(await count(table, "b"), table).toBe(1);
    }
  });

  it("the operator-wide reset clears the log with profiles and foods and label bytes with everything", async () => {
    await fill();
    await resetData(h.db, "profiles", store);
    expect((await h.db.select().from(s.foodLog))).toEqual([]);
    expect(await h.db.select().from(s.householdFoods)).toHaveLength(2);
    expect(await store.list()).toHaveLength(4);
    await resetData(h.db, "all", store);
    expect(await h.db.select().from(s.householdFoods)).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("member account deletion removes their entries and detaches them from foods they added", async () => {
    await fill();
    expect(await deleteFoodLogForPerson(h.db, 3)).toBe(1);
    await detachPersonFromFoods(h.db, "a", 1);
    expect((await h.db.select({ n: s.householdFoods.name, by: s.householdFoods.createdByPersonId, conf: s.householdFoods.confirmedByPersonId }).from(s.householdFoods).where(eq(s.householdFoods.householdId, "a")))).toEqual([{ n: "Food a", by: null, conf: null }]);
    expect(await count("food_log", "a")).toBe(1);
    expect(await count("household_foods", "a")).toBe(1);
    expect(await detachPersonFromFoods(h.db, "a", 1)).toBeUndefined();
  });

  it("deleting a person row removes their entries and keeps their foods with a null creator", async () => {
    await fill();
    await h.db.delete(s.people).where(eq(s.people.id, 3));
    expect(await count("food_log", "a")).toBe(1);
    await h.db.delete(s.people).where(eq(s.people.id, 1));
    expect(await count("food_log", "a")).toBe(0);
    expect((await h.db.select().from(s.householdFoods).where(eq(s.householdFoods.householdId, "a")))[0]).toMatchObject({ createdByPersonId: null, confirmedByPersonId: null });
  });

  it("clear helpers mark the classes and scope by household", async () => {
    await fill();
    await h.db.transaction(async (tx) => {
      expect(await clearFoodLog(tx, { householdId: "a", personIds: [] })).toBe(0);
      expect(await clearFoodLog(tx, { householdId: "a", personIds: [3] })).toBe(1);
      expect(await clearFoodLog(tx, { householdId: "a" })).toBe(1);
      expect(await clearHouseholdFoods(tx, "a")).toHaveLength(1);
    });
    expect(await count("food_log", "b")).toBe(1);
  });
});

describe("label extractions", () => {
  it("counts per household and prunes rows older than 90 days", async () => {
    const now = new Date("2027-01-31T00:00:00Z");
    await recordLabelExtraction(h.db, { householdId: "a", personId: 1, model: "m", inputTokens: 1000.9, outputTokens: 50, outcome: "success" }, "2026-10-01T00:00:00.000Z");
    await recordLabelExtraction(h.db, { householdId: "a", personId: 1, model: "m", inputTokens: 1, outputTokens: 1, outcome: "unreadable" }, "2027-01-30T00:00:00.000Z");
    await recordLabelExtraction(h.db, { householdId: "b", personId: null, model: "m", inputTokens: 1, outputTokens: 1, outcome: "error" }, "2026-10-01T00:00:00.000Z");
    expect(await countLabelExtractions(h.db, "a", "2026-01-01T00:00:00.000Z")).toBe(2);
    expect(await countLabelExtractions(h.db, "a", "2027-01-01T00:00:00.000Z")).toBe(1);
    expect((await h.db.select().from(s.labelExtractions))[0]).toMatchObject({ inputTokens: 1000 });
    expect(await pruneLabelExtractions(h.db, now)).toBe(2);
    expect(await h.db.select().from(s.labelExtractions)).toHaveLength(1);
    await expect(h.db.insert(s.labelExtractions).values({ householdId: "a", model: "m", outcome: "maybe" as never, createdAt: "2027-01-01T00:00:00Z" })).rejects.toThrow();
  });
});

describe("error type", () => {
  it("carries a code", () => {
    expect(new FoodDataError("invalid", "x")).toMatchObject({ code: "invalid", name: "FoodDataError" });
    expect(foodLogClass.prefix).toBe("food-log/");
  });
});

describe("personal export", () => {
  it("lists only the member's own entries, naming foods and never exposing macros or ids", async () => {
    const { readAccountExport } = await import("../lib/server/account-export");
    await h.db.insert(s.authUsers).values({ id: "u1", name: "Asha", email: "asha@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "u1", personId: 1, role: "owner" });
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, eat(1, uid));
    await logFoodEntry(h.db, A, eat(3, uid));
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-01", slot: "lunch", kind: "planned", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } });
    const result = (await readAccountExport(h.db, { userId: "u1", personId: 1 }))!;
    expect(result.foodLog.map((e) => [e.date, e.recipe, e.food, e.brand, e.grams])).toEqual([["2026-11-01", "dal-tadka", null, null, null], ["2026-11-02", null, "Greek yogurt 0%", "Oikos", 175]]);
    expect(JSON.stringify(result.foodLog)).not.toMatch(/kcal|protein|household/i);
  });
});
