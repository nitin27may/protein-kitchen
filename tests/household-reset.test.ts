import { eq, inArray, isNull } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";
import { createMemoryStore } from "../lib/blob/memory";
import { foodLabelKeys, photoKeys } from "../lib/photos/keys";
import { resolveHouseholdAccess, type HouseholdAccess } from "../lib/auth/household-access";
import { resetHouseholdData, ResetPhotoCleanupError } from "../lib/server/household-reset";
import { RESET_SCOPES, resetCounts } from "../lib/server/reset";

let h: DbHandle;
let access: HouseholdAccess;
let store: ReturnType<typeof createMemoryStore>;
const at = "2026-11-02T00:00:00Z";

beforeEach(async () => {
  h = await openDb();
  store = createMemoryStore();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.ingredients).values({
    id: 1, slug: "fixture", name: "Fixture", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0,
    fatG: 0, fibreG: 0, source: "USDA", sourceId: "fixture", aisle: "test", whereToBuy: [],
    isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  });
  await h.db.insert(s.recipes).values({
    id: 1, slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["lunch"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  });
  await h.db.insert(s.habits).values({ id: 1, slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false });
  for (const [index, householdId] of ["a", "b", null].entries()) {
    const id = index + 1;
    await h.db.insert(s.people).values({
      id, householdId, name: `Fixture ${id}`, sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    });
    await h.db.insert(s.planSetups).values({ id, householdId, personIds: [id], startDate: "2026-11-02", endDate: "2026-11-02", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: at });
    await h.db.insert(s.plans).values({ id, householdId, setupId: id, seed: 1, createdAt: at });
    await h.db.insert(s.planSlots).values({ id, planId: id, date: "2026-11-02", slot: "lunch", recipeId: 1 });
    await h.db.insert(s.planSlotPortions).values({ planSlotId: id, personId: id, servings: 1 });
    await h.db.insert(s.preferences).values({ personId: id, recipeId: 1, kind: "like" });
    await h.db.insert(s.groceryManual).values({ planId: id, text: "Synthetic", checked: true });
    await h.db.insert(s.groceryState).values({ planId: id, ingredientId: 1, checked: true });
    await h.db.insert(s.pantry).values({ householdId, ingredientId: 1, have: true, alwaysStock: true });
    await h.db.insert(s.planProgress).values({ planId: id, step: "prep", doneAt: at });
    await h.db.insert(s.planPartState).values({ planId: id, componentSlug: "fixture", mode: "have", updatedAt: at });
    await h.db.insert(s.habitLog).values({ personId: id, habitId: 1, date: "2026-11-02", done: true });
    await h.db.insert(s.reminderLog).values({ personId: id, date: "2026-11-02", sentAt: at });
    await h.db.insert(s.personRoutines).values({ personId: id, habitId: 1, days: [1], timeOfDay: "morning", servings: 1, active: true });
    await h.db.insert(s.planRoutines).values({ planId: id, personId: id, habitId: 1, days: [1], timeOfDay: "morning", servings: 1 });
    await h.db.insert(s.prepTaskState).values({ householdId, date: "2026-11-02", taskKey: "same-key", done: true });
    await h.db.insert(s.personRecipeFeedback).values({ personId: id, recipeId: 1, uid: `personal-${id}`, rating: 5, createdAt: at, updatedAt: at });
    await h.db.insert(s.recipeFeedback).values({ householdId, recipeId: 1, rating: 5, notes: "Synthetic", uid: `feedback-${id}` });
    await h.db.insert(s.savedViews).values({ householdId, list: "recipes", name: "Synthetic", query: "", uid: `view-${id}` });
    await h.db.insert(s.recipeLinks).values({ householdId, recipeId: 1, uid: `link-${id}`, kind: "recipe", url: "https://example.test", title: "Synthetic", createdAt: at, updatedAt: at });
    await h.db.insert(s.photos).values({ householdId, uid: `photo-${id}`, recipeId: 1, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at });
    await h.db.insert(s.photoDecisions).values({ householdId, uid: `decision-${id}`, subjectKind: "recipe", subjectSlug: "fixture", candidateKey: "commons:fixture", decision: "rejected", createdAt: at, updatedAt: at });
    if (householdId) {
      const [food] = await h.db.insert(s.householdFoods).values({
        householdId, uid: `food-${id}`, name: "Synthetic food", kcal: 100, proteinG: 10, carbsG: 10, fatG: 1, labelBasis: "per_100g", source: "MANUAL",
        labelPhotoUid: `label-${id}`, labelPhotoSha256: "0".repeat(64), createdAt: at, updatedAt: at, confirmedAt: at, createdByPersonId: id,
      }).returning();
      await h.db.insert(s.foodLog).values({ householdId, uid: `log-${id}`, personId: id, date: "2026-11-02", slot: "snack", kind: "extra", householdFoodId: food!.id, grams: 50, planId: id, createdAt: at, updatedAt: at });
    }
    for (const key of Object.values(foodLabelKeys(`label-${id}`))) await store.put(key, Buffer.from(`label-${id}`), "image/webp");
    for (const key of Object.values(photoKeys(`photo-${id}`))) await store.put(key, Buffer.from(`fixture-${id}`), "image/webp");
  }
  await h.db.insert(s.authUsers).values({ id: "owner", name: "Fixture", email: "fixture@example.test", emailVerified: true });
  await h.db.insert(s.householdMembers).values({ userId: "owner", householdId: "a", personId: 1, role: "owner" });
  access = await resolveHouseholdAccess(h.db, "owner", "a");
});

async function snapshot(householdId: string | null) {
  const owned = (column: AnyPgColumn<{ data: string }>) => householdId === null ? isNull(column) : eq(column, householdId);
  const people = h.db.select({ id: s.people.id }).from(s.people).where(owned(s.people.householdId));
  const plans = h.db.select({ id: s.plans.id }).from(s.plans).where(owned(s.plans.householdId));
  const slots = h.db.select({ id: s.planSlots.id }).from(s.planSlots).where(inArray(s.planSlots.planId, plans));
  return Promise.all([
    h.db.select().from(s.people).where(owned(s.people.householdId)),
    h.db.select().from(s.plans).where(owned(s.plans.householdId)),
    h.db.select().from(s.planSetups).where(owned(s.planSetups.householdId)),
    h.db.select().from(s.planSlots).where(inArray(s.planSlots.planId, plans)),
    h.db.select().from(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slots)),
    h.db.select().from(s.groceryManual).where(inArray(s.groceryManual.planId, plans)),
    h.db.select().from(s.groceryState).where(inArray(s.groceryState.planId, plans)),
    h.db.select().from(s.planProgress).where(inArray(s.planProgress.planId, plans)),
    h.db.select().from(s.planPartState).where(inArray(s.planPartState.planId, plans)),
    h.db.select().from(s.planRoutines).where(inArray(s.planRoutines.planId, plans)),
    h.db.select().from(s.preferences).where(inArray(s.preferences.personId, people)),
    h.db.select().from(s.personRoutines).where(inArray(s.personRoutines.personId, people)),
    h.db.select().from(s.personRecipeFeedback).where(inArray(s.personRecipeFeedback.personId, people)),
    h.db.select().from(s.habitLog).where(inArray(s.habitLog.personId, people)),
    h.db.select().from(s.reminderLog).where(inArray(s.reminderLog.personId, people)),
    ...[s.pantry, s.prepTaskState, s.recipeFeedback, s.savedViews, s.recipeLinks, s.photos, s.photoDecisions, s.householdFoods, s.syncState]
      .map((table) => h.db.select().from(table).where(owned(table.householdId))),
  ]);
}

it.each(RESET_SCOPES)("resets only owned %s data and preserves foreign/legacy records, bytes and the library", async (scope) => {
  const foreign = await snapshot("b"), legacy = await snapshot(null);
  const own = await resetCounts(h.db, "a");
  const list = vi.spyOn(store, "list");
  await resetHouseholdData(h.db, access, scope, store);
  expect(await snapshot("b")).toEqual(foreign);
  expect(await snapshot(null)).toEqual(legacy);
  expect(list).not.toHaveBeenCalled();
  const counts = await resetCounts(h.db, "a");
  const expected = {
    plans: { ...own, plans: 0, groceryItems: 1, progressTicks: 1, partChoices: 0, planRoutines: 0, planSteps: 0 },
    groceries: { ...own, groceryItems: 0 },
    progress: { ...own, progressTicks: 0 },
    ratings: { ...own, ratings: 0 },
    profiles: { ...own, profiles: 0, plans: 0, groceryItems: 1, progressTicks: 0, ratings: 1, partChoices: 0, routineChoices: 0, planRoutines: 0, planSteps: 0, foodLog: 0 },
    all: Object.fromEntries(Object.keys(own).map((key) => [key, 0])),
  };
  expect(counts).toEqual(expected[scope]);
  expect(await h.db.select().from(s.recipes)).toHaveLength(1);
  expect(await h.db.select().from(s.ingredients)).toHaveLength(1);
  expect(await h.db.select().from(s.habits)).toHaveLength(1);
  expect(await h.db.select().from(s.authUsers)).toHaveLength(1);
  expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", householdId: "a", personId: scope === "profiles" || scope === "all" ? null : 1 }]);
  for (const id of [1, 2, 3]) for (const key of Object.values(photoKeys(`photo-${id}`))) {
    expect(await store.exists(key)).toBe(scope !== "all" || id !== 1);
  }
  for (const id of [1, 2, 3]) for (const key of Object.values(foodLabelKeys(`label-${id}`))) {
    expect(await store.exists(key)).toBe(scope !== "all" || id !== 1);
  }
});

it("refuses stale/non-owner access and absent photo storage before committing", async () => {
  const before = await snapshot("a");
  await expect(resetHouseholdData(h.db, access, "all")).rejects.toThrow("photo storage");
  await h.db.update(s.householdMembers).set({ role: "member" });
  await expect(resetHouseholdData(h.db, access, "plans")).rejects.toThrow("access changed");
  const member = await resolveHouseholdAccess(h.db, "owner", "a");
  await expect(resetHouseholdData(h.db, member, "plans")).rejects.toThrow("Only a household owner");
  await h.db.delete(s.householdMembers);
  await expect(resetHouseholdData(h.db, access, "plans")).rejects.toThrow("not available");
  expect(await snapshot("a")).toEqual(before);
});

it("rolls back destructive SQL and revision marks without touching any bytes", async () => {
  const before = await snapshot("a");
  const drop = vi.spyOn(store, "delete");
  await h.failWrite("sync_state", "insert", "fail_reset_marker", "NEW.data_class = 'photos'");
  await expect(resetHouseholdData(h.db, access, "all", store)).rejects.toThrow();
  expect(await snapshot("a")).toEqual(before);
  expect(drop).not.toHaveBeenCalled();
});

it.each(["portion", "routine", "setup", "creator", "personalCreator", "routineCreator", "reminder"])("refuses a %s reference outside the household and rolls prior deletes back", async (kind) => {
  if (kind === "portion") await h.db.insert(s.planSlotPortions).values({ planSlotId: 2, personId: 1, servings: 1 });
  if (kind === "routine") await h.db.insert(s.planRoutines).values({ planId: 2, personId: 1, habitId: 1, days: [1], timeOfDay: "morning", servings: 1 });
  if (kind === "setup") await h.db.update(s.planSetups).set({ personIds: [1, 2] }).where(eq(s.planSetups.id, 2));
  if (kind === "creator") await h.db.update(s.photos).set({ createdByPersonId: 1 }).where(eq(s.photos.householdId, "b"));
  if (kind === "personalCreator") await h.db.update(s.personRecipeFeedback).set({ createdByPersonId: 1 }).where(eq(s.personRecipeFeedback.personId, 2));
  if (kind === "routineCreator") await h.db.update(s.personRoutines).set({ createdByPersonId: 1 }).where(eq(s.personRoutines.personId, 2));
  if (kind === "reminder") await h.db.insert(s.reminderBatches).values({ householdId: "b", id: "foreign-batch", personId: 1, date: "2026-11-02", payload: { title: "Synthetic", body: "Synthetic", url: "/" }, expiresAt: at, createdAt: at });
  const before = await snapshot("a"), foreign = await snapshot("b");
  await expect(resetHouseholdData(h.db, access, "profiles", store)).rejects.toThrow("outside this household");
  expect(await snapshot("a")).toEqual(before);
  expect(await snapshot("b")).toEqual(foreign);
});

it("reports post-commit cleanup failure explicitly and only attempts owned photo keys outside the transaction", async () => {
  let attempts = 0;
  vi.spyOn(store, "delete").mockImplementation(async (key) => {
    attempts++;
    expect([...Object.values(photoKeys("photo-1")), ...Object.values(foodLabelKeys("label-1"))]).toContain(key);
    expect(await h.db.select().from(s.photos).where(eq(s.photos.householdId, "a"))).toEqual([]);
    throw new Error("PRIVATE_STORAGE_FAILURE");
  });
  await expect(resetHouseholdData(h.db, access, "all", store)).rejects.toBeInstanceOf(ResetPhotoCleanupError);
  expect(attempts).toBe(4);
  expect(await h.db.select().from(s.people).where(eq(s.people.householdId, "a"))).toEqual([]);
  expect(await h.db.select().from(s.householdFoods).where(eq(s.householdFoods.householdId, "a"))).toEqual([]);
  expect(await store.exists(photoKeys("photo-2").master)).toBe(true);
});

it("supports a non-photo reset without opening storage", async () => {
  await resetHouseholdData(h.db, access, "progress");
  expect((await resetCounts(h.db, "a")).progressTicks).toBe(0);
});
