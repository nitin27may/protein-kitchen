import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuth } from "../lib/auth/server";
import { getData, getDb } from "../lib/server/context";
import * as s from "../lib/db/schema";
import { loadData } from "../lib/data/load";
import { computeDayTotals } from "../lib/foods/totals";
import { archiveHouseholdFood, createHouseholdFood } from "../lib/human/household-foods";
import { plannedMealsFrom, toLoggedEntries } from "../lib/food-log/keys";
import { nutritionLookups } from "../lib/food-log/lookups";
import { persistNewPlan, persistPlanDeletion, persistRegeneratedPlan } from "../lib/server/plan-persistence";
import { getFoodEntries, getFoodUsage, getHouseholdFoodRows, readFoodEntries, readFoodUsage, readHouseholdFoods, readPlanSlots, readablePersonIds } from "../lib/server/food-log-queries";
import { assertMayLog, LogError } from "../lib/server/food-log-service";
import {
  deleteEntry, loadFoodCatalog, logExtra, markMealEaten, markMealSkipped, markMealSwapped, markRestOfDayEaten, updateEntry,
} from "../app/foods/log-actions";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/server", () => ({ getAuth: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

const data = loadData(process.cwd());
const [R1, R2, R3] = [...data.recipes.values()].filter((r) => r.kind === "recipe").slice(0, 3).map((r) => r.slug) as [string, string, string];
const OATS = [...data.ingredients.keys()][0]!;
const DAY = "2026-11-02";
const session = vi.fn();
let h: DbHandle;
let planA: number;
let lunchA: number;
let dinnerA: number;
let planB: number;
let slotB: number;
let pancake: string;
let foreignFood: string;
let ids: Map<string, number>;

function signIn(user: string | null) {
  session.mockResolvedValue(user ? { user: { id: user, emailVerified: true }, session: { id: `s-${user}` } } : null);
}
const logRows = () => h.db.select().from(s.foodLog);
const lookups = async () => nutritionLookups(data.recipes, data.ingredients, await readHouseholdFoods(h.db, "a", { includeArchived: true }));

beforeEach(async () => {
  vi.resetAllMocks();
  h = await openDb();
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "synthetic" }));
  vi.mocked(getAuth).mockResolvedValue({ handler: vi.fn(), api: { getSession: session, setPassword: vi.fn(), changePassword: vi.fn() } });
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  const person = (id: number, householdId: string, name: string) => ({ id, householdId, name, sex: "other" as const, birthDate: "1990-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [] });
  await h.db.insert(s.people).values([person(1, "a", "Asha"), person(3, "a", "Chen"), person(4, "a", "Dev"), person(2, "b", "Ben")]);
  const users = [["oa", "a", 1, "owner"], ["ma", "a", 3, "member"], ["ob", "b", 2, "owner"]] as const;
  await h.db.insert(s.authUsers).values(users.map(([id]) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));
  await h.db.insert(s.authSessions).values(users.map(([id]) => ({ id: `s-${id}`, userId: id, token: `t-${id}`, updatedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) })));
  await h.db.insert(s.householdMembers).values(users.map(([userId, householdId, personId, role]) => ({ userId, householdId, personId, role })));
  const rows = await h.db.insert(s.recipes).values([R1, R2, R3].map((slug) => {
    const r = data.recipes.get(slug)!;
    return { slug, name: r.name, kind: r.kind, family: r.family, mealSlots: r.meal_slots, cuisine: r.cuisine, isIndian: r.is_indian, servings: r.servings, prepMin: r.prep_min, activeMin: r.active_min, totalMin: r.total_min, equipment: r.equipment, tags: r.tags, fridgeDays: r.fridge_days };
  })).returning({ id: s.recipes.id, slug: s.recipes.slug });
  ids = new Map(rows.map((r) => [r.slug, r.id]));
  const setup = (householdId: string, personIds: number[]) => ({ householdId, personIds, startDate: DAY, endDate: "2026-11-08", mealTypes: ["lunch", "dinner"], cuisineBalance: 0.5, maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true }, prepStyle: "leftovers" as const, createdAt: "2026-10-24T00:00:00Z" });
  planA = await persistNewPlan(h.db, {
    setup: setup("a", [1, 3]), seed: 1, routines: [], recipeIds: ids,
    slots: [
      { date: DAY, slot: "lunch", recipeSlug: R1, servings: { 1: 1.5, 3: 1 }, locked: false, reasons: [] },
      { date: DAY, slot: "dinner", recipeSlug: R2, servings: { 1: 1, 3: 1 }, locked: false, reasons: [] },
    ],
  });
  planB = await persistNewPlan(h.db, { setup: setup("b", [2]), seed: 2, routines: [], recipeIds: ids, slots: [{ date: DAY, slot: "lunch", recipeSlug: R1, servings: { 2: 1 }, locked: false, reasons: [] }] });
  const slots = await h.db.select().from(s.planSlots);
  lunchA = slots.find((x) => x.planId === planA && x.slot === "lunch")!.id;
  dinnerA = slots.find((x) => x.planId === planA && x.slot === "dinner")!.id;
  slotB = slots.find((x) => x.planId === planB)!.id;
  const food = (name: string) => ({ name, brand: "Costco", barcode: null, state: "ready" as const, kcal: 345, proteinG: 7.3, carbsG: 70, fatG: 2, fibreG: null, servingLabel: "1/3 cup", servingG: 55, labelBasis: "per_serving" as const, labelValues: {}, source: "LABEL" as const, isDairy: false });
  pancake = (await createHouseholdFood(h.db, { householdId: "a", personId: 1 }, food("Pancake mix"))).uid;
  foreignFood = (await createHouseholdFood(h.db, { householdId: "b", personId: 2 }, food("Their mix"))).uid;
  signIn("oa");
});

const eaten = (personId = 1, planSlotId = lunchA) => ({ personId, planSlotId });
const extra = (over: Record<string, unknown> = {}) => ({ personIds: [1], date: DAY, slot: "snack" as const, item: { type: "ingredient" as const, ingredientSlug: OATS, grams: 40 }, ...over });

describe("who may log", () => {
  it("anonymous visitors are refused by every action before any database access", async () => {
    signIn(null);
    const results = await Promise.all([
      markMealEaten(eaten()), markMealSkipped(eaten()), markMealSwapped({ ...eaten(), item: extra().item }), logExtra(extra()),
      updateEntry({ personId: 1, uid: "x" }), deleteEntry({ personId: 1, uid: "x" }), markRestOfDayEaten({ personId: 1, planId: planA, date: DAY }), loadFoodCatalog(),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "Sign in before continuing." });
    expect(getDb).not.toHaveBeenCalled();
    expect(getData).not.toHaveBeenCalled();
    expect(await logRows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an owner logs for anyone in the household, several people at once", async () => {
    expect(await markMealEaten(eaten(3))).toMatchObject({ ok: true });
    const res = await logExtra(extra({ personIds: [1, 3, 4] }));
    expect(res).toMatchObject({ ok: true, entries: [{ personId: 1 }, { personId: 3 }, { personId: 4 }] });
    expect(await logRows()).toHaveLength(4);
  });

  it("a member logs only for themselves", async () => {
    signIn("ma");
    expect(await markMealEaten(eaten(3))).toMatchObject({ ok: true });
    expect(await logExtra(extra({ personIds: [3] }))).toMatchObject({ ok: true });
    for (const r of [await markMealEaten(eaten(1)), await markMealSkipped(eaten(1)), await logExtra(extra({ personIds: [1] })), await markRestOfDayEaten({ personId: 1, planId: planA, date: DAY })]) {
      expect(r).toEqual({ ok: false, error: "You can only change your own profile and routine choices." });
    }
    expect(await logExtra(extra({ personIds: [3, 1] }))).toEqual({ ok: false, error: "Only a household owner can do that." });
    expect((await logRows()).every((e) => e.personId === 3)).toBe(true);
  });

  it("a member cannot edit or delete another person's entry even by passing their own id", async () => {
    const mine = await logExtra(extra({ personIds: [1] }));
    expect(mine.ok).toBe(true);
    const uid = (mine as { entries: { uid: string }[] }).entries[0]!.uid;
    signIn("ma");
    expect(await updateEntry({ personId: 3, uid, item: { type: "ingredient", ingredientSlug: OATS, grams: 10 } })).toEqual({ ok: false, error: "That entry is not in this log." });
    expect(await deleteEntry({ personId: 3, uid })).toEqual({ ok: false, error: "That entry is not in this log." });
    expect(await deleteEntry({ personId: 1, uid })).toMatchObject({ ok: false });
    expect(await logRows()).toHaveLength(1);
  });

  it("refuses another household's person, slot, plan and food, and leaves nothing behind", async () => {
    expect(await logExtra(extra({ personIds: [2] }))).toEqual({ ok: false, error: "That profile is not in this household." });
    expect(await markMealEaten(eaten(2, slotB))).toMatchObject({ ok: false, error: "That planned meal is not in this household." });
    expect(await markMealEaten(eaten(1, slotB))).toMatchObject({ ok: false });
    expect(await logExtra(extra({ item: { type: "food", householdFoodUid: foreignFood, qty: 1, unit: "serving" } }))).toEqual({ ok: false, error: "That food is not in this household." });
    expect(await markMealSwapped({ ...eaten(), item: { type: "food", householdFoodUid: foreignFood, qty: 50, unit: "g" } })).toMatchObject({ ok: false });
    expect(await markRestOfDayEaten({ personId: 1, planId: planB, date: DAY })).toEqual({ ok: true, marked: 0 });
    expect(await logRows()).toEqual([]);
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, slotB)))[0]!.locked).toBe(false);
    signIn("ob");
    expect(await logExtra(extra({ personIds: [1] }))).toMatchObject({ ok: false });
    expect(await logExtra(extra({ personIds: [2], item: { type: "food", householdFoodUid: pancake, qty: 1, unit: "g" } }))).toMatchObject({ ok: false });
  });
});

describe("answering a planned meal", () => {
  it("Ate it copies the plan, locks the slot and is idempotent", async () => {
    expect(await markMealEaten(eaten())).toMatchObject({ ok: true, created: true, lockedBefore: false });
    expect(await markMealEaten(eaten())).toMatchObject({ ok: true, created: false });
    expect(await logRows()).toMatchObject([{ kind: "planned", recipeSlug: R1, servings: 1.5, plannedRecipeSlug: R1, planId: planA, date: DAY, slot: "lunch" }]);
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(true);
    expect(await markMealEaten(eaten(1, lunchA))).toMatchObject({ lockedBefore: true });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("takes an eaten servings override and refuses a person with no portion", async () => {
    expect(await markMealEaten({ ...eaten(), servings: 0.5 })).toMatchObject({ ok: true });
    expect((await logRows())[0]).toMatchObject({ servings: 0.5, plannedServings: 1.5 });
    expect(await markMealEaten(eaten(4))).toMatchObject({ ok: false });
  });

  it("Skipped names the skipped meal and is never counted as eaten; eaten and skipped replace each other", async () => {
    expect(await markMealSkipped({ ...eaten(), note: "Not hungry" })).toMatchObject({ ok: true, lockedBefore: false });
    let rows = await logRows();
    expect(rows).toMatchObject([{ kind: "skipped", recipeSlug: R1, servings: 1.5, plannedRecipeSlug: R1, note: "Not hungry" }]);
    const l = await lookups();
    const meals = plannedMealsFrom(await readPlanSlots(h.db, "a", planA, DAY), [1]);
    const entries = async () => toLoggedEntries(await readFoodEntries(h.db, "a", { personIds: [1], from: DAY, to: DAY }), meals);
    let day = computeDayTotals({ personId: "1", date: DAY, today: "2026-11-03", meals, entries: await entries(), lookups: l });
    expect(day.eaten!.protein_g).toBe(0);
    expect(day.skippedKeys).toEqual([`1:${DAY}:lunch`]);
    expect(await markMealEaten(eaten())).toMatchObject({ ok: true, created: true });
    rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("planned");
    day = computeDayTotals({ personId: "1", date: DAY, today: "2026-11-03", meals, entries: await entries(), lookups: l });
    expect(day.eaten!.protein_g).toBeCloseTo(l.recipePerServing(R1)!.protein_g * 1.5);
    expect(await markMealSkipped(eaten())).toMatchObject({ ok: true });
    expect((await logRows()).map((e) => e.kind)).toEqual(["skipped"]);
  });

  it("Swapped records the planned recipe and the item eaten instead; only the swap counts", async () => {
    const res = await markMealSwapped({ ...eaten(), item: { type: "food", householdFoodUid: pancake, qty: 2, unit: "serving" }, note: "Pancakes" });
    expect(res).toMatchObject({ ok: true, lockedBefore: false });
    expect((await logRows())[0]).toMatchObject({ kind: "swap", recipeSlug: null, grams: 110, displayQty: 2, displayUnit: "serving", plannedRecipeSlug: R1, plannedServings: 1.5, planId: planA, slot: "lunch", note: "Pancakes" });
    const meals = plannedMealsFrom(await readPlanSlots(h.db, "a", planA, DAY), [1]);
    const rows = await readFoodEntries(h.db, "a", { personIds: [1], from: DAY, to: DAY });
    expect(rows[0]!.householdFoodUid).toBe(pancake);
    const day = computeDayTotals({ personId: "1", date: DAY, today: DAY, meals, entries: toLoggedEntries(rows, meals), lookups: await lookups() });
    expect(day.eaten!.protein_g).toBeCloseTo(7.3 * 1.1);
    expect(day.plannedPendingKeys).toEqual([`1:${DAY}:dinner`]);
    expect(day.eaten!.fibre_at_least).toBe(true);
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(true);
    expect(await markMealSwapped({ ...eaten(), item: { type: "ingredient", ingredientSlug: OATS, grams: 50 } })).toMatchObject({ ok: true });
    expect((await logRows()).map((e) => e.kind)).toEqual(["swap"]);
  });

  it("Mark the rest of the day answers only the unanswered meals, in one go, and is idempotent", async () => {
    expect(await markMealSkipped(eaten())).toMatchObject({ ok: true });
    expect(await markRestOfDayEaten({ personId: 1, planId: planA, date: DAY })).toEqual({ ok: true, marked: 1 });
    expect(await markRestOfDayEaten({ personId: 1, planId: planA, date: DAY })).toEqual({ ok: true, marked: 0 });
    expect((await logRows()).map((e) => `${e.slot}:${e.kind}`).sort()).toEqual(["dinner:planned", "lunch:skipped"]);
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, dinnerA)))[0]!.locked).toBe(true);
  });

  it("Mark the rest rolls back every meal if one fails", async () => {
    await h.failWrite("food_log", "INSERT", "boom_rest", "NEW.slot = 'dinner'");
    await expect(markRestOfDayEaten({ personId: 1, planId: planA, date: DAY })).rejects.toThrow();
    expect(await logRows()).toEqual([]);
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(false);
  });
});

describe("extras", () => {
  it("logs any date, including one outside every plan, in grams, servings, pieces or millilitres", async () => {
    const piece = await createHouseholdFood(h.db, { householdId: "a", personId: 1 }, { name: "Biscuit", state: "ready", kcal: 480, proteinG: 6, carbsG: 70, fatG: 20, fibreG: 2, pieceG: 12, densityGPerMl: 1, labelBasis: "per_100g", source: "MANUAL" });
    const log = (item: unknown, over: Record<string, unknown> = {}) => logExtra(extra({ date: "2027-03-01", item, ...over }));
    expect(await log({ type: "food", householdFoodUid: pancake, qty: 2, unit: "serving" })).toMatchObject({ ok: true });
    expect(await log({ type: "food", householdFoodUid: piece.uid, qty: 3, unit: "piece" }, { slot: "shake" })).toMatchObject({ ok: true });
    expect(await log({ type: "food", householdFoodUid: piece.uid, qty: 150, unit: "ml" })).toMatchObject({ ok: true });
    expect(await log({ type: "food", householdFoodUid: piece.uid, qty: 25, unit: "g" })).toMatchObject({ ok: true });
    expect(await log({ type: "recipe", recipeSlug: R2, servings: 0.5 })).toMatchObject({ ok: true });
    expect(await log({ type: "ingredient", ingredientSlug: OATS, grams: 40 })).toMatchObject({ ok: true });
    const rows = await logRows();
    expect(rows.map((r) => [r.grams, r.displayQty, r.displayUnit])).toEqual([[110, 2, "serving"], [36, 3, "piece"], [150, 150, "ml"], [25, null, null], [null, null, null], [40, null, null]]);
    expect(rows.every((r) => r.kind === "extra" && r.date === "2027-03-01" && r.planId === null)).toBe(true);
  });

  it("refuses bad input and unknown or unusable foods without writing", async () => {
    const bad: [unknown, string][] = [
      [extra({ date: "2026-02-30" }), "That date does not exist."],
      [extra({ date: "tomorrow" }), "Use a date like 2026-11-02"],
      [extra({ slot: "brunch" }), ""],
      [extra({ personIds: [] }), ""],
      [extra({ item: { type: "ingredient", ingredientSlug: OATS, grams: 6000 } }), ""],
      [extra({ item: { type: "recipe", recipeSlug: R1, servings: 0 } }), ""],
      [extra({ item: { type: "ingredient", ingredientSlug: "no-such-ingredient", grams: 10 } }), "That ingredient is not in the library."],
      [extra({ item: { type: "recipe", recipeSlug: "no-such-recipe", servings: 1 } }), "That recipe is not in the library."],
      [extra({ item: { type: "food", householdFoodUid: pancake, qty: 2, unit: "piece" } }), "This food has no weight per piece."],
      [extra({ item: { type: "food", householdFoodUid: pancake, qty: 2, unit: "ml" } }), "This food has no density, so millilitres cannot be converted."],
      [extra({ item: { type: "food", householdFoodUid: pancake, qty: 4000, unit: "serving" } }), "That is more than 5 kg. Check the amount."],
      [null, ""],
    ];
    for (const [input, message] of bad) {
      const r = await logExtra(input as never);
      expect(r.ok).toBe(false);
      if (message) expect((r as { error: string }).error).toContain(message);
    }
    expect(await logRows()).toEqual([]);
  });

  it("refuses an archived food and a component that is not a meal", async () => {
    await archiveHouseholdFood(h.db, { householdId: "a", personId: 1 }, pancake);
    expect(await logExtra(extra({ item: { type: "food", householdFoodUid: pancake, qty: 50, unit: "g" } }))).toEqual({ ok: false, error: "That food is archived. Restore it before logging it." });
    const component = [...data.recipes.values()].find((r) => r.kind === "component")!;
    expect(await logExtra(extra({ item: { type: "recipe", recipeSlug: component.slug, servings: 1 } }))).toMatchObject({ ok: false });
  });

  it("derives a serving from millilitres and density when the label gives no grams", async () => {
    const drink = await createHouseholdFood(h.db, { householdId: "a", personId: 1 }, { name: "Soy drink", state: "ready", kcal: 40, proteinG: 3.3, carbsG: 1, fatG: 1.8, fibreG: 0.5, servingMl: 250, densityGPerMl: 1.03, labelBasis: "per_100ml", source: "LABEL" });
    expect(await logExtra(extra({ item: { type: "food", householdFoodUid: drink.uid, qty: 1, unit: "serving" } }))).toMatchObject({ ok: true });
    expect((await logRows())[0]!.grams).toBeCloseTo(257.5);
  });
});

describe("editing and undoing", () => {
  it("edits the amount of an extra, keeps its slot rules for answers, and clears or keeps the note", async () => {
    const added = (await logExtra(extra({ note: "first" }))) as { entries: { uid: string }[] };
    const uid = added.entries[0]!.uid;
    expect(await updateEntry({ personId: 1, uid, item: { type: "ingredient", ingredientSlug: OATS, grams: 60 }, slot: "breakfast", date: "2026-11-01" })).toMatchObject({ ok: true });
    expect((await logRows())[0]).toMatchObject({ grams: 60, slot: "breakfast", date: "2026-11-01", note: "first", kind: "extra" });
    expect(await updateEntry({ personId: 1, uid, note: null })).toMatchObject({ ok: true });
    expect((await logRows())[0]!.note).toBeNull();
    expect(await updateEntry({ personId: 1, uid, item: { type: "food", householdFoodUid: pancake, qty: 1, unit: "serving" } })).toMatchObject({ ok: true });
    expect(await updateEntry({ personId: 1, uid, item: { type: "recipe", recipeSlug: R1, servings: 2 } })).toMatchObject({ ok: true });
    expect(await updateEntry({ personId: 1, uid, slot: "dinner" })).toMatchObject({ ok: true });
    expect((await logRows())[0]).toMatchObject({ recipeSlug: R1, servings: 2, grams: null, slot: "dinner" });
    expect(await updateEntry({ personId: 1, uid, item: { type: "food", householdFoodUid: pancake, qty: 1, unit: "serving" } })).toMatchObject({ ok: true });
    expect(await updateEntry({ personId: 1, uid, note: "kept" })).toMatchObject({ ok: true });
    expect((await logRows())[0]).toMatchObject({ grams: 55, note: "kept" });
  });

  it("an eaten planned meal may change servings only, and keeps its day and slot; a skipped meal has no amount", async () => {
    const eat = (await markMealEaten(eaten())) as { uid: string };
    expect(await updateEntry({ personId: 1, uid: eat.uid, item: { type: "recipe", recipeSlug: R1, servings: 1 } })).toMatchObject({ ok: true });
    expect((await logRows())[0]).toMatchObject({ servings: 1, plannedServings: 1.5 });
    expect(await updateEntry({ personId: 1, uid: eat.uid, item: { type: "ingredient", ingredientSlug: OATS, grams: 10 } })).toMatchObject({ ok: false });
    expect(await updateEntry({ personId: 1, uid: eat.uid, item: { type: "recipe", recipeSlug: R2, servings: 1 } })).toMatchObject({ ok: false });
    expect(await updateEntry({ personId: 1, uid: eat.uid, slot: "dinner" })).toMatchObject({ ok: false });
    expect(await updateEntry({ personId: 1, uid: eat.uid, date: "2026-11-03" })).toMatchObject({ ok: false });
    expect(await updateEntry({ personId: 1, uid: eat.uid, slot: "lunch", date: DAY, note: "same day and slot is fine" })).toMatchObject({ ok: true });
    const skip = (await markMealSkipped(eaten(1, dinnerA))) as { uid: string };
    expect(await updateEntry({ personId: 1, uid: skip.uid, item: { type: "recipe", recipeSlug: R2, servings: 1 } })).toMatchObject({ ok: false });
    expect(await updateEntry({ personId: 1, uid: skip.uid, note: "later" })).toMatchObject({ ok: true });
    const swap = (await markMealSwapped({ ...eaten(3, dinnerA), item: { type: "ingredient", ingredientSlug: OATS, grams: 30 } })) as { uid: string };
    expect(await updateEntry({ personId: 3, uid: swap.uid, item: { type: "ingredient", ingredientSlug: OATS, grams: 45 } })).toMatchObject({ ok: true });
    expect((await logRows()).find((e) => e.uid === swap.uid)).toMatchObject({ kind: "swap", grams: 45, plannedRecipeSlug: R2 });
  });

  it("Undo removes the entries; for a meal it hands back the lock only when no other answer remains", async () => {
    const a = (await markMealEaten(eaten(1))) as { uid: string };
    const b = (await markMealEaten(eaten(3))) as { uid: string };
    expect(await deleteEntry({ personId: 1, uid: a.uid, unlockSlotId: lunchA })).toEqual({ ok: true, removed: true });
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(true);
    expect(await deleteEntry({ personId: 3, uid: b.uid, unlockSlotId: lunchA })).toEqual({ ok: true, removed: true });
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(false);
    expect(await logRows()).toEqual([]);
    expect(await deleteEntry({ personId: 1, uid: a.uid })).toEqual({ ok: false, error: "That entry is not in this log." });
  });

  it("Undo keeps the lock for another slot, another day, or an extra", async () => {
    const eat = (await markMealEaten(eaten(1, dinnerA))) as { uid: string };
    expect(await deleteEntry({ personId: 1, uid: eat.uid, unlockSlotId: lunchA })).toMatchObject({ ok: true });
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, dinnerA)))[0]!.locked).toBe(true);
    const ex = (await logExtra(extra())) as { entries: { uid: string }[] };
    await h.db.update(s.planSlots).set({ locked: true }).where(eq(s.planSlots.id, lunchA));
    expect(await deleteEntry({ personId: 1, uid: ex.entries[0]!.uid, unlockSlotId: lunchA })).toMatchObject({ ok: true });
    expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, lunchA)))[0]!.locked).toBe(true);
    expect(await deleteEntry({ personId: 1, uid: "no-such-entry" })).toMatchObject({ ok: false });
  });
});

describe("plans change under the log", () => {
  it("a locked, eaten slot survives regeneration and still answers its planned meal", async () => {
    await markMealEaten(eaten(1, lunchA));
    const lockedRows = await h.db.select().from(s.planSlots).where(eq(s.planSlots.locked, true));
    expect(lockedRows.map((x) => x.id)).toEqual([lunchA]);
    await persistRegeneratedPlan(h.db, planA, 99, [
      { date: DAY, slot: "lunch", recipeSlug: R1, servings: { 1: 1.5, 3: 1 }, locked: true, reasons: [] },
      { date: DAY, slot: "dinner", recipeSlug: R3, servings: { 1: 1, 3: 1 }, locked: false, reasons: [] },
    ], ids);
    const slots = await readPlanSlots(h.db, "a", planA, DAY);
    expect(slots.find((x) => x.slot === "lunch")).toMatchObject({ id: lunchA, recipeSlug: R1, locked: true });
    expect(slots.find((x) => x.slot === "dinner")!.recipeSlug).toBe(R3);
    const meals = plannedMealsFrom(slots, [1]);
    const day = computeDayTotals({ personId: "1", date: DAY, today: DAY, meals, entries: toLoggedEntries(await readFoodEntries(h.db, "a", { personIds: [1], from: DAY, to: DAY }), meals), lookups: await lookups() });
    expect(day.plannedPendingKeys).toEqual([`1:${DAY}:dinner`]);
  });

  it("an answer for a meal that was replaced no longer answers the new meal", async () => {
    await markMealSkipped(eaten(1, dinnerA));
    await h.db.update(s.planSlots).set({ recipeId: ids.get(R3)! }).where(eq(s.planSlots.id, dinnerA));
    const meals = plannedMealsFrom(await readPlanSlots(h.db, "a", planA, DAY), [1]);
    const entries = toLoggedEntries(await readFoodEntries(h.db, "a", { personIds: [1], from: DAY, to: DAY }), meals);
    const day = computeDayTotals({ personId: "1", date: DAY, today: DAY, meals, entries, lookups: await lookups() });
    expect(day.plannedPendingKeys).toContain(`1:${DAY}:dinner`);
    expect(await markRestOfDayEaten({ personId: 1, planId: planA, date: DAY })).toEqual({ ok: true, marked: 2 });
  });

  it("entries survive the plan being deleted", async () => {
    await markMealEaten(eaten(1, lunchA));
    await persistPlanDeletion(h.db, planA);
    expect(await logRows()).toMatchObject([{ kind: "planned", planId: null, recipeSlug: R1 }]);
  });
});

describe("reads", () => {
  it("lists a household's entries only, and a member reads only their own person", async () => {
    await logExtra(extra({ personIds: [1, 3] }));
    signIn("ob");
    await logExtra(extra({ personIds: [2] }));
    expect(await readFoodEntries(h.db, "a", { personIds: [1, 2, 3], from: DAY, to: DAY })).toHaveLength(2);
    expect(await readFoodEntries(h.db, "b", { personIds: [1, 2, 3], from: DAY, to: DAY })).toHaveLength(1);
    expect(await readFoodEntries(h.db, "a", { personIds: [], from: DAY, to: DAY })).toEqual([]);
    expect(readablePersonIds({ role: "owner", personId: 1 }, [1, 3])).toEqual([1, 3]);
    expect(readablePersonIds({ role: "member", personId: 3 }, [1, 3])).toEqual([3]);
  });

  it("counts use for recents without counting skipped meals, per household", async () => {
    await logExtra(extra({ personIds: [1, 3], item: { type: "food", householdFoodUid: pancake, qty: 50, unit: "g" } }));
    await logExtra(extra());
    await logExtra(extra({ item: { type: "recipe", recipeSlug: R2, servings: 1 } }));
    await markMealSkipped(eaten());
    const usage = await readFoodUsage(h.db, "a");
    expect(usage[`hf:${pancake}`]).toMatchObject({ count: 2 });
    expect(usage[OATS]).toMatchObject({ count: 1 });
    expect(usage[`recipe:${R2}`]).toMatchObject({ count: 1 });
    expect(usage[R1]).toBeUndefined();
    expect(await readFoodUsage(h.db, "b")).toEqual({});
  });

  it("loads the catalog with the library, recipes and only this household's active foods", async () => {
    await logExtra(extra());
    const res = await loadFoodCatalog();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.foods.find((f) => f.key === OATS)).toMatchObject({ kind: "ingredient" });
    expect(res.foods.find((f) => f.key === `recipe:${R1}`)).toMatchObject({ kind: "recipe" });
    expect(res.foods.find((f) => f.key === `hf:${pancake}`)).toMatchObject({ kind: "household", brand: "Costco", servingG: 55, servingLabel: "1/3 cup" });
    expect(res.foods.some((f) => f.key === `hf:${foreignFood}`)).toBe(false);
    expect(res.foods.some((f) => f.kind === "recipe" && data.recipes.get(f.key.slice(7))!.kind !== "recipe")).toBe(false);
    expect(res.hasHouseholdFoods).toBe(true);
    expect(res.usage[OATS]!.count).toBe(1);
    expect(res.foods.find((f) => f.key === `hf:${pancake}`)!.nutrients.fibre_g).toBeUndefined();
    await archiveHouseholdFood(h.db, { householdId: "a", personId: 1 }, pancake);
    const after = await loadFoodCatalog();
    expect(after.ok && after.hasHouseholdFoods).toBe(false);
    signIn("ob");
    const theirs = await loadFoodCatalog();
    expect(theirs.ok && theirs.foods.some((f) => f.key === `hf:${foreignFood}`)).toBe(true);
    expect(theirs.ok && theirs.foods.some((f) => f.key === `hf:${pancake}`)).toBe(false);
  });

  it("the request-scoped reads resolve the household and narrow a member to their own person", async () => {
    await logExtra(extra({ personIds: [1, 3] }));
    expect((await getFoodEntries([1, 3], DAY, DAY)).map((e) => e.personId)).toEqual([1, 3]);
    expect(Object.keys(await getFoodUsage())).toEqual([OATS]);
    expect((await getHouseholdFoodRows(false)).map((f) => f.uid)).toEqual([pancake]);
    signIn("ma");
    expect((await getFoodEntries([1, 3], DAY, DAY)).map((e) => e.personId)).toEqual([3]);
  });

  it("the service refuses a profile-less actor and an unplanned portion even if called directly", () => {
    expect(() => assertMayLog({ role: "owner", personId: null }, [1])).toThrow(LogError);
    expect(() => assertMayLog({ role: "member", personId: 3 }, [3, 1])).toThrow("You can only log your own food.");
  });

  it("lets an unexpected failure through instead of hiding it", async () => {
    vi.mocked(getDb).mockRejectedValue(new Error("database down"));
    await expect(loadFoodCatalog()).rejects.toThrow("database down");
  });

  it("reports a missing household session as an error instead of throwing", async () => {
    await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "oa"));
    expect((await loadFoodCatalog()).ok).toBe(false);
  });
});
