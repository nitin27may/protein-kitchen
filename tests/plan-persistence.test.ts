import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import * as s from "../lib/db/schema";
import type { PlannedSlot } from "../lib/planner/types";
import { persistIngredientPreferences, persistNewPlan, persistPlanDeletion, persistRegeneratedPlan } from "../lib/server/plan-persistence";

let h: DbHandle;
let personId: number;
let habitId: number;
let recipes: Map<string, number>;
const setup = {
  personIds: [] as number[], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
  cuisineBalance: 0.5, maxActiveMin: null, healthFocus: { nutrientDense: true, lowSugar: true, light: true },
  prepStyle: "leftovers" as const, createdAt: "2026-11-01T12:00:00.000Z",
};
const slot = (recipeSlug = "fixture", locked = false, date = "2026-11-02"): PlannedSlot => ({
  recipeSlug, date, slot: "dinner", servings: { [personId]: 1.5 }, locked, reasons: [], isLeftover: false,
});
const create = (slots: PlannedSlot[] = [slot()]) => persistNewPlan(h.db, {
  setup: { ...setup, personIds: [personId] }, seed: 1, slots, recipeIds: recipes,
  routines: [{ planId: 0, personId, habitId, days: [1, 2], timeOfDay: "morning", servings: 1 }],
});

beforeEach(async () => {
  h = openDb(":memory:", path.resolve(__dirname, "..", "db", "migrations"));
  const [person] = await h.db.insert(s.people).values({
    name: "Persistence fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  personId = person!.id;
  const [habit] = await h.db.insert(s.habits).values({
    slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  habitId = habit!.id;
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  }).returning({ id: s.recipes.id });
  recipes = new Map([["fixture", recipe!.id]]);
});
afterEach(() => h.sqlite.close());

describe("atomic plan persistence", () => {
  it.each(["plan_setups", "plans", "plan_routines", "plan_slots", "plan_slot_portions"])("rolls back creation if %s fails", async (table) => {
    h.sqlite.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
    await expect(create()).rejects.toThrow();
    for (const target of [s.planSetups, s.plans, s.planRoutines, s.planSlots, s.planSlotPortions]) {
      expect(await h.db.select().from(target)).toEqual([]);
    }
    h.sqlite.exec("DROP TRIGGER fail_insert");
    expect(await create()).toBeGreaterThan(0);
  });

  it("stores setup, routine snapshot, slots and portions together", async () => {
    const planId = await create([{ ...slot(), isLeftover: true }]);
    expect(await h.db.select().from(s.planSetups)).toHaveLength(1);
    expect(await h.db.select().from(s.planRoutines)).toMatchObject([{ planId, personId, habitId }]);
    expect(await h.db.select().from(s.planSlots)).toMatchObject([{ planId, isLeftover: true }]);
    expect(await h.db.select().from(s.planSlotPortions)).toMatchObject([{ personId, servings: 1.5 }]);
  });

  it("rolls back the entire new plan rather than silently skipping an unknown recipe", async () => {
    await expect(create([slot(), slot("missing")])).rejects.toThrow('recipe "missing" is missing');
    for (const table of [s.planSetups, s.plans, s.planRoutines, s.planSlots, s.planSlotPortions]) {
      expect(await h.db.select().from(table)).toEqual([]);
    }
  });

  it("rolls back earlier inserted meals when a later portion violates a foreign key", async () => {
    await expect(create([slot(), { ...slot(), servings: { 999999: 1 } }])).rejects.toThrow();
    expect(await h.db.select().from(s.plans)).toEqual([]);
    expect(await h.db.select().from(s.planSetups)).toEqual([]);
    expect(await h.db.select().from(s.planSlotPortions)).toEqual([]);
    expect(await h.db.select().from(s.planRoutines)).toEqual([]);
  });

  it("retains the original meals and seed when regeneration fails", async () => {
    const id = await create();
    const before = await h.db.select().from(s.planSlots);
    const portions = await h.db.select().from(s.planSlotPortions);
    await expect(persistRegeneratedPlan(h.db, id, 2, [slot(), slot("missing")], recipes)).rejects.toThrow("missing");
    expect(await h.db.select().from(s.planSlots)).toEqual(before);
    expect(await h.db.select().from(s.planSlotPortions)).toEqual(portions);
    expect(await h.db.select().from(s.plans)).toMatchObject([{ seed: 1 }]);
  });

  it("replaces unlocked meals and portions but preserves locked meals and routine snapshots", async () => {
    const id = await create([slot("fixture", true), slot("fixture", false, "2026-11-03")]);
    const [locked] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.locked, true));
    const routines = await h.db.select().from(s.planRoutines);
    await persistRegeneratedPlan(h.db, id, 2, [slot("fixture", true), { ...slot("fixture", false, "2026-11-04"), servings: { [personId]: 2 } }], recipes);
    expect(await h.db.select().from(s.planSlots).where(eq(s.planSlots.locked, true))).toEqual([locked]);
    expect(await h.db.select().from(s.planSlots).where(eq(s.planSlots.locked, false))).toMatchObject([{ date: "2026-11-04" }]);
    expect(await h.db.select().from(s.planSlotPortions)).toHaveLength(2);
    expect(await h.db.select().from(s.planRoutines)).toEqual(routines);
    expect(await h.db.select().from(s.plans)).toMatchObject([{ seed: 2 }]);
  });

  it.each([
    ["delete", "plan_slots"],
    ["insert", "plan_slots"],
    ["insert", "plan_slot_portions"],
    ["update", "plans"],
  ])("restores the entire original plan if regeneration fails on %s %s", async (operation, table) => {
    const id = await create([slot("fixture", true), slot("fixture", false, "2026-11-03")]);
    const before = {
      plans: await h.db.select().from(s.plans),
      slots: await h.db.select().from(s.planSlots),
      portions: await h.db.select().from(s.planSlotPortions),
      routines: await h.db.select().from(s.planRoutines),
    };
    h.sqlite.exec(`CREATE TRIGGER fail_regenerate BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected regeneration failure'); END`);
    await expect(persistRegeneratedPlan(h.db, id, 2, [slot("fixture", false, "2026-11-04")], recipes)).rejects.toThrow();
    expect(await h.db.select().from(s.plans)).toEqual(before.plans);
    expect(await h.db.select().from(s.planSlots)).toEqual(before.slots);
    expect(await h.db.select().from(s.planSlotPortions)).toEqual(before.portions);
    expect(await h.db.select().from(s.planRoutines)).toEqual(before.routines);
  });

  it("isolates regeneration from another plan, including portions and routine snapshots", async () => {
    const id = await create();
    const other = await create([slot("fixture", false, "2026-11-05")]);
    const otherSlots = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, other));
    const otherPortions = await h.db.select().from(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, otherSlots[0]!.id));
    await persistRegeneratedPlan(h.db, id, 2, [slot("fixture", false, "2026-11-04")], recipes);
    expect(await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, other))).toEqual(otherSlots);
    expect(await h.db.select().from(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, otherSlots[0]!.id))).toEqual(otherPortions);
    expect(await h.db.select().from(s.plans).where(eq(s.plans.id, other))).toMatchObject([{ seed: 1 }]);
    expect(await h.db.select().from(s.planRoutines).where(eq(s.planRoutines.planId, other))).toHaveLength(1);
  });

  it("persists all household portions and defaults an omitted leftover flag to false", async () => {
    const [second] = await h.db.insert(s.people).values({
      name: "Second fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    const input = slot();
    delete input.isLeftover;
    input.servings[String(second!.id)] = 0.75;
    await create([input]);
    expect(await h.db.select().from(s.planSlotPortions)).toMatchObject([
      { personId, servings: 1.5 }, { personId: second!.id, servings: 0.75 },
    ]);
    expect(await h.db.select().from(s.planSlots)).toMatchObject([{ isLeftover: false }]);
  });

  it("supports plans without routines and all-locked regeneration", async () => {
    const id = await persistNewPlan(h.db, {
      setup: { ...setup, personIds: [personId] }, seed: 1, slots: [slot("fixture", true)], routines: [], recipeIds: recipes,
    });
    const before = await h.db.select().from(s.planSlots);
    await persistRegeneratedPlan(h.db, id, 2, [slot("fixture", true)], recipes);
    expect(await h.db.select().from(s.planSlots)).toEqual(before);
    expect(await h.db.select().from(s.planRoutines)).toEqual([]);
    expect(await h.db.select().from(s.planSlotPortions)).toHaveLength(1);
  });

  it("refuses regeneration after a plan was removed", async () => {
    await expect(persistRegeneratedPlan(h.db, 9999, 2, [], recipes)).rejects.toThrow("no longer exists");
  });

  it("deletes the plan, its setup and dependent rows, but not other plans", async () => {
    const id = await create();
    const other = await create();
    await persistPlanDeletion(h.db, id);
    expect(await h.db.select().from(s.plans)).toMatchObject([{ id: other }]);
    expect(await h.db.select().from(s.planSetups)).toHaveLength(1);
    expect(await h.db.select().from(s.planSlots)).toMatchObject([{ planId: other }]);
    expect(await h.db.select().from(s.planSlotPortions)).toHaveLength(1);
    expect(await h.db.select().from(s.planRoutines)).toMatchObject([{ planId: other }]);
    await persistPlanDeletion(h.db, id);
    expect(await h.db.select().from(s.plans)).toHaveLength(1);
  });

  it("rolls back deletion and dependent cascades if removing the setup fails", async () => {
    const id = await create();
    const before = {
      plans: await h.db.select().from(s.plans), slots: await h.db.select().from(s.planSlots),
      portions: await h.db.select().from(s.planSlotPortions), routines: await h.db.select().from(s.planRoutines),
    };
    h.sqlite.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON plan_setups BEGIN SELECT RAISE(ABORT, 'injected setup deletion failure'); END");
    await expect(persistPlanDeletion(h.db, id)).rejects.toThrow();
    expect(await h.db.select().from(s.plans)).toEqual(before.plans);
    expect(await h.db.select().from(s.planSlots)).toEqual(before.slots);
    expect(await h.db.select().from(s.planSlotPortions)).toEqual(before.portions);
    expect(await h.db.select().from(s.planRoutines)).toEqual(before.routines);
  });

  it("replaces like/avoid preferences without removing pins or other people's choices", async () => {
    const [ingredient] = await h.db.insert(s.ingredients).values({
      slug: "fixture", name: "Fixture", state: "ready", aliases: [], kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0,
      source: "CNF", sourceId: "fixture", aisle: "test", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    }).returning({ id: s.ingredients.id });
    const [other] = await h.db.insert(s.people).values({
      name: "Other fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await h.db.insert(s.preferences).values([
      { personId, recipeId: recipes.get("fixture")!, kind: "pin" },
      { personId, ingredientId: ingredient!.id, kind: "like" },
      { personId: other!.id, ingredientId: ingredient!.id, kind: "like" },
    ]);
    await persistIngredientPreferences(h.db, personId, [{ ingredientId: ingredient!.id, kind: "avoid" }]);
    expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, personId))).toMatchObject([
      { kind: "pin" }, { kind: "avoid" },
    ]);
    expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, other!.id))).toMatchObject([{ kind: "like" }]);
    await persistIngredientPreferences(h.db, personId, []);
    expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, personId))).toMatchObject([{ kind: "pin" }]);
  });

  it("preserves prior preferences if an insert fails after deletion", async () => {
    await h.db.insert(s.preferences).values({ personId, recipeId: recipes.get("fixture")!, kind: "like" });
    const before = await h.db.select().from(s.preferences);
    await expect(persistIngredientPreferences(h.db, personId, [{ ingredientId: 999999, kind: "avoid" }])).rejects.toThrow();
    expect(await h.db.select().from(s.preferences)).toEqual(before);
  });
});
