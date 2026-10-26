import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { NutrientsPer, NutritionLookups } from "../lib/foods/totals";
import { eatenBar, entryViews, mealAnswer, reviewPlan, MARKER_TEXT } from "../lib/food-log/day-view";
import { eatenSummaryLine, fibreText, liveLine, proteinCaption, quantityText, trimNumber, unitWord } from "../lib/food-log/format";
import { isAnswerKind, plannedKey, plannedMealsFrom, toLoggedEntries, type FoodLogRowLike } from "../lib/food-log/keys";
import { householdPer100, nutritionLookups } from "../lib/food-log/lookups";
import { defaultAmount, defaultSlot, portionsOf, previewAmount, unitsFor, type SheetFood } from "../lib/food-log/preview";

const row = (over: Partial<FoodLogRowLike> = {}): FoodLogRowLike => ({
  uid: "e1", personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra", recipeSlug: null, servings: null, ingredientSlug: null, householdFoodUid: null,
  grams: null, displayQty: null, displayUnit: null, planId: null, plannedRecipeSlug: null, plannedServings: null, note: null, ...over,
});
const lookups: NutritionLookups = {
  food: (key) => ({ "oats": { kcal: 380, protein_g: 13, carbs_g: 66, fat_g: 7, fibre_g: 10 }, "hf:pancake": { kcal: 345, protein_g: 7.3, carbs_g: 70, fat_g: 2 } } as Record<string, NutrientsPer>)[key],
  recipePerServing: (slug) => (slug === "dal" ? { kcal: 500, protein_g: 30, carbs_g: 60, fat_g: 10, fibre_g: 12 } : undefined),
};
const names = { recipe: (s: string) => (s === "" ? "Meal" : s === "dal" ? "Dal bowl" : s), ingredient: (s: string) => (s === "" ? "Food" : s), food: (u: string) => `food ${u}` };

describe("keys", () => {
  it("builds the person, date and slot key without a plan id", () => {
    expect(plannedKey(3, "2026-11-02", "lunch")).toBe("3:2026-11-02:lunch");
    expect(plannedKey("3", "2026-11-02", "lunch")).toBe(plannedKey(3, "2026-11-02", "lunch"));
  });
  it("makes one planned meal per person with a portion", () => {
    const meals = plannedMealsFrom([{ id: 9, date: "2026-11-02", slot: "lunch", recipeSlug: "dal", servings: { "1": 1.5, "2": 0 } }], [1, 2, 3]);
    expect(meals).toEqual([{ key: "1:2026-11-02:lunch", personId: "1", date: "2026-11-02", slot: "lunch", recipe: "dal", servings: 1.5, planSlotId: 9 }]);
  });
  it("tells answer kinds from extras", () => {
    expect(["planned", "skipped", "swap"].every((k) => isAnswerKind(k as never))).toBe(true);
    expect(isAnswerKind("extra")).toBe(false);
  });
  it("maps rows to entries: recipe, ingredient, household food, skipped with no item, extra with no key", () => {
    const meals = plannedMealsFrom([{ id: 1, date: "2026-11-02", slot: "lunch", recipeSlug: "dal", servings: { "1": 1 } }], [1]);
    const entries = toLoggedEntries([
      row({ uid: "a", kind: "planned", recipeSlug: "dal", servings: 1, plannedRecipeSlug: "dal" }),
      row({ uid: "b", slot: "snack", ingredientSlug: "oats", grams: 40 }),
      row({ uid: "c", slot: "snack", householdFoodUid: "pancake", grams: 110 }),
      row({ uid: "d", slot: "dinner", kind: "skipped", recipeSlug: "dal", servings: 1, plannedRecipeSlug: "dal" }),
      row({ uid: "f", slot: "shake", grams: 5 }),
    ], meals);
    expect(entries[0]).toMatchObject({ id: "a", plannedKey: "1:2026-11-02:lunch", recipe: "dal", servings: 1 });
    expect(entries[1]).toMatchObject({ foodKey: "oats", grams: 40 });
    expect(entries[1]!.plannedKey).toBeUndefined();
    expect(entries[2]).toMatchObject({ foodKey: "hf:pancake", grams: 110 });
    expect(entries[3]).toEqual({ id: "d", personId: "1", date: "2026-11-02", kind: "skipped", plannedKey: "1:2026-11-02:dinner" });
    expect(entries[4]).toEqual({ id: "f", personId: "1", date: "2026-11-02", kind: "extra" });
  });
  it("an answer to a different recipe than the one now planned does not answer the new meal", () => {
    const meals = plannedMealsFrom([{ id: 1, date: "2026-11-02", slot: "lunch", recipeSlug: "dal", servings: { "1": 1 } }], [1]);
    const [stale] = toLoggedEntries([row({ kind: "skipped", plannedRecipeSlug: "khichdi" })], meals);
    expect(stale!.plannedKey).toBeUndefined();
    const [noMeal] = toLoggedEntries([row({ kind: "skipped", plannedRecipeSlug: "khichdi" })]);
    expect(noMeal!.plannedKey).toBe("1:2026-11-02:lunch");
  });
});

describe("lookups", () => {
  const data = loadData(process.cwd());
  const slug = [...data.recipes.values()].find((r) => r.kind === "recipe")!.slug;
  const ing = [...data.ingredients.keys()][0]!;
  const l = nutritionLookups(data.recipes, data.ingredients, [{ uid: "u1", kcal: 100, proteinG: 5, carbsG: 10, fatG: 2, fibreG: null }, { uid: "u2", kcal: 100, proteinG: 5, carbsG: 10, fatG: 2, fibreG: 3 }]);
  it("resolves library recipes, ingredients and household foods; fibre null stays undefined", () => {
    expect(l.recipePerServing(slug)!.kcal).toBeGreaterThan(0);
    expect(l.recipePerServing("no-such-recipe")).toBeUndefined();
    expect(l.food(ing)).toBeDefined();
    expect(l.food("no-such-ingredient")).toBeUndefined();
    expect(l.food("hf:u1")).toEqual({ kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 2 });
    expect(l.food("hf:u2")!.fibre_g).toBe(3);
    expect(l.food("hf:other-household")).toBeUndefined();
    expect(householdPer100({ uid: "x", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, fibreG: 0 }).fibre_g).toBe(0);
  });
  it("treats a component cycle as unresolved", () => {
    const a = { ...data.recipes.get(slug)!, items: [{ component: "ring-b", grams: 10 }] };
    const comp = (self: string, other: string) => ({ ...a, slug: self, kind: "component" as const, items: [{ component: other, grams: 10 }] });
    const cyc = nutritionLookups(new Map([["ring-a", comp("ring-a", "ring-b")], ["ring-b", comp("ring-b", "ring-a")]]) as never, data.ingredients, []);
    expect(cyc.recipePerServing("ring-a")).toBeUndefined();
  });
  it("rethrows an error that is not a missing reference", () => {
    const broken = nutritionLookups(new Map([["bad", { servings: 1, items: null }]]) as never, data.ingredients, []);
    expect(() => broken.recipePerServing("bad")).toThrow(TypeError);
  });
});

describe("format", () => {
  it("trims numbers and words units", () => {
    expect(trimNumber(1.5)).toBe("1.5");
    expect(trimNumber(2)).toBe("2");
    expect([unitWord("g", 1), unitWord("ml", 2), unitWord("serving", 1), unitWord("serving", 2), unitWord("piece", 1), unitWord("piece", 3)]).toEqual(["g", "ml", "serving", "servings", "piece", "pieces"]);
    expect(quantityText(2, "piece")).toBe("2 pieces");
  });
  it("fibre wording: reported, partly reported (floor), not reported", () => {
    expect(fibreText({ fibre_g: 4.2, fibre_at_least: false, fibre_not_reported_count: 0 })).toBe("4.2 g fibre");
    expect(fibreText({ fibre_g: 4, fibre_at_least: true, fibre_not_reported_count: 1 })).toBe("at least 4 g fibre (1 not reported)");
    expect(fibreText({ fibre_g: 0, fibre_at_least: true, fibre_not_reported_count: 2 })).toBe("fibre not reported");
  });
  it("live line and captions", () => {
    const t = { kcal: 259.6, protein_g: 14.2, carbs_g: 1, fat_g: 1, fibre_g: 0, fibre_at_least: false, fibre_not_reported_count: 0 };
    expect(liveLine("110 g", t)).toBe("110 g · 14 g protein · 260 kcal");
    expect(liveLine("110 g", { ...t, fibre_at_least: true, fibre_g: 0, fibre_not_reported_count: 1 })).toBe("110 g · 14 g protein · 260 kcal · fibre not reported");
    expect(proteinCaption(62, 48, 120)).toBe("Eaten 62 g, 48 g still planned, target 120 g");
    expect(proteinCaption(62, 0.2, 120)).toBe("Eaten 62 g, nothing still planned, target 120 g");
    expect(eatenSummaryLine({ loggedDays: 3, totalDays: 7, averageG: 98.4, targetG: 120 })).toBe("Eaten protein: 3 of 7 days logged, average 98 g against 120 g");
    expect(eatenSummaryLine({ loggedDays: 0, totalDays: 7, averageG: null, targetG: 120 })).toBe("Eaten protein: 0 of 7 days logged");
  });
});

describe("preview", () => {
  const pancake: SheetFood = { key: "hf:p", kind: "household", name: "Pancake mix", nutrients: { kcal: 345, protein_g: 7.3, carbs_g: 70, fat_g: 2 }, servingG: 55, pieceG: 30, densityGPerMl: 1.1, densityEstimated: true };
  const oats: SheetFood = { key: "oats", kind: "ingredient", name: "Oats", nutrients: { kcal: 380, protein_g: 13, carbs_g: 66, fat_g: 7, fibre_g: 10 } };
  const dal: SheetFood = { key: "recipe:dal", kind: "recipe", name: "Dal", nutrients: { kcal: 500, protein_g: 30, carbs_g: 60, fat_g: 10, fibre_g: 12 } };
  it("offers only the units a food supports", () => {
    expect(unitsFor(pancake)).toEqual(["g", "serving", "piece", "ml"]);
    expect(unitsFor(oats)).toEqual(["g"]);
    expect(unitsFor(dal)).toEqual(["serving"]);
    expect(portionsOf(oats)).toEqual({});
    expect(portionsOf(pancake)).toEqual({ servingG: 55, pieceG: 30, densityGPerMl: 1.1, densityEstimated: true });
  });
  it("starts with a serving, a piece or 100 g", () => {
    expect(defaultAmount(dal)).toEqual({ qty: 1, unit: "serving" });
    expect(defaultAmount(pancake)).toEqual({ qty: 1, unit: "serving" });
    expect(defaultAmount({ ...pancake, servingG: undefined })).toEqual({ qty: 1, unit: "piece" });
    expect(defaultAmount(oats)).toEqual({ qty: 100, unit: "g" });
  });
  it("the pancake mix at 2 servings is 110 g, with the figures doubled and fibre flagged not reported", () => {
    const p = previewAmount(pancake, 2, "serving");
    expect(p.ok && p.grams).toBe(110);
    expect(p.ok && p.line).toBe("2 servings (110 g) · 8 protein".replace("8 protein", "8 g protein") + " · 380 kcal · fibre not reported");
  });
  it("grams, estimated millilitres, library fibre, recipes, refusals", () => {
    expect(previewAmount(oats, 40, "g")).toMatchObject({ ok: true, grams: 40, line: "40 g · 5 g protein · 152 kcal" });
    const ml = previewAmount(pancake, 100, "ml");
    expect(ml.ok && ml.estimated).toBe(true);
    expect(ml.ok && ml.line).toContain("estimated from a density guess");
    expect(previewAmount(dal, 1.5, "serving")).toMatchObject({ ok: true, servings: 1.5, grams: null, line: "1.5 servings · 45 g protein · 750 kcal" });
    expect(previewAmount(dal, 1, "g")).toMatchObject({ ok: false });
    expect(previewAmount(dal, 0, "serving")).toMatchObject({ ok: false });
    expect(previewAmount(oats, 2, "piece")).toMatchObject({ ok: false, reason: "This food has no weight per piece." });
  });
  it("chooses a slot by time of day", () => {
    expect([defaultSlot(480), defaultSlot(720), defaultSlot(1080), defaultSlot(1300)]).toEqual(["breakfast", "lunch", "dinner", "snack"]);
  });
});

describe("day view", () => {
  const meals = plannedMealsFrom([
    { id: 1, date: "2026-11-02", slot: "lunch", recipeSlug: "dal", servings: { "1": 1 } },
    { id: 2, date: "2026-11-02", slot: "dinner", recipeSlug: "dal", servings: { "1": 2 } },
  ], [1]);
  const rows = [
    row({ uid: "a", kind: "planned", recipeSlug: "dal", servings: 1, plannedRecipeSlug: "dal" }),
    row({ uid: "b", slot: "dinner", kind: "skipped", recipeSlug: "dal", servings: 2, plannedRecipeSlug: "dal" }),
    row({ uid: "c", slot: "snack", ingredientSlug: "oats", grams: 40, displayQty: 2, displayUnit: "piece" }),
    row({ uid: "d", slot: "snack", householdFoodUid: "pancake", grams: 110 }),
    row({ uid: "e", slot: "snack", ingredientSlug: "gone", grams: 10 }),
    row({ uid: "f", slot: "breakfast", recipeSlug: "dal", servings: 1.5 }),
    row({ uid: "g", slot: "breakfast", householdFoodUid: "gone", grams: 10 }),
  ];
  it("builds entry views: names, amounts, nutrition, unresolved items, skipped meals not counted", () => {
    const v = entryViews(rows, lookups, names);
    expect(v[0]).toMatchObject({ name: "Dal bowl", amount: "1 serving", proteinG: 30, kcal: 500, resolved: true, plannedName: "Dal bowl" });
    expect(v[1]).toMatchObject({ kind: "skipped", amount: "", proteinG: 0, kcal: 0, resolved: true, item: null });
    expect(v[2]).toMatchObject({ amount: "2 pieces (40 g)", proteinG: 5.2, item: { type: "ingredient", ingredientSlug: "oats", grams: 40 } });
    expect(v[3]).toMatchObject({ name: "food pancake", amount: "110 g", item: { type: "food", householdFoodUid: "pancake", grams: 110 } });
    expect(v[4]).toMatchObject({ resolved: false, proteinG: 0 });
    expect(v[5]).toMatchObject({ amount: "1.5 servings", proteinG: 45, item: { type: "recipe", servings: 1.5 } });
    expect(v[6]!.resolved).toBe(false);
    expect(entryViews([row({ kind: "skipped", plannedRecipeSlug: null, recipeSlug: null })], lookups, names)[0]!.name).toBe("Meal");
    expect(entryViews([row({ ingredientSlug: null, grams: null })], lookups, names)[0]).toMatchObject({ name: "Food", item: null, amount: "" });
    expect(entryViews([row({ ingredientSlug: null, grams: 5 })], lookups, names)[0]!.item).toBeNull();
  });
  it("finds the answer to a planned meal by person, date, slot and recipe", () => {
    const v = entryViews(rows, lookups, names);
    expect(mealAnswer(meals[0]!, v).status).toBe("eaten");
    expect(mealAnswer(meals[1]!, v).status).toBe("skipped");
    expect(mealAnswer({ ...meals[0]!, recipe: "other" }, v)).toEqual({ status: "pending", entry: null });
    const swapped = entryViews([row({ kind: "swap", ingredientSlug: "oats", grams: 40, plannedRecipeSlug: "dal" })], lookups, names);
    expect(mealAnswer(meals[0]!, swapped).status).toBe("swapped");
  });
  it("computes the eaten bar: skipped is never eaten, pending counts what is unanswered", () => {
    const b = eatenBar({ personId: 1, date: "2026-11-02", today: "2026-11-02", meals, rows: rows.slice(0, 2), lookups });
    expect(b.eaten!.protein_g).toBe(30);
    expect(b.pendingProteinG).toBe(0);
    expect(b.pendingCount).toBe(0);
    const open = eatenBar({ personId: 1, date: "2026-11-02", today: "2026-11-02", meals, rows: [], lookups });
    expect(open).toMatchObject({ status: "open", pendingProteinG: 90, pendingCount: 2 });
    expect(eatenBar({ personId: 1, date: "2026-11-02", today: "2026-11-03", meals, rows: [], lookups })).toMatchObject({ status: "not_logged", eaten: null });
  });
  it("reviews a plan: markers per day, logged days only in the average", () => {
    const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
    const planMeals = plannedMealsFrom(dates.slice(0, 5).flatMap((date, i) => [{ id: i + 1, date, slot: "lunch", recipeSlug: "dal", servings: { "1": 1 } }]), [1]);
    const mk = (date: string, over: Partial<FoodLogRowLike>) => row({ date, slot: "lunch", ...over });
    const { cells, summaries } = reviewPlan({
      people: [{ id: 1, name: "Asha", targetG: 120 }], dates, today: "2026-11-04", meals: planMeals, lookups,
      rows: [
        mk("2026-11-02", { uid: "a", kind: "planned", recipeSlug: "dal", servings: 1, plannedRecipeSlug: "dal" }),
        mk("2026-11-03", { uid: "b", kind: "swap", ingredientSlug: "oats", grams: 100, plannedRecipeSlug: "dal" }),
        mk("2026-11-04", { uid: "c", slot: "snack", ingredientSlug: "oats", grams: 100 }),
      ],
    });
    const marker = (date: string) => cells.find((c) => c.date === date)!.marker;
    expect(marker("2026-11-01")).toBe("not_logged");
    expect(marker("2026-11-02")).toBe("ate_plan");
    expect(marker("2026-11-03")).toBe("swapped");
    expect(marker("2026-11-04")).toBe("partial");
    expect(marker("2026-11-05")).toBe("open");
    expect(marker("2026-11-06")).toBe("none");
    expect(cells.find((c) => c.date === "2026-11-01")).toMatchObject({ eatenProteinG: null, plannedProteinG: 30 });
    expect(summaries[0]).toMatchObject({ loggedDays: 3, totalDays: 6, targetG: 120 });
    expect(summaries[0]!.averageG).toBeCloseTo((30 + 13 + 13) / 3);
  });
  it("marker corner cases: skipped, extras only, no plan, past day with no plan", () => {
    const one = (meals: ReturnType<typeof plannedMealsFrom>, rows: FoodLogRowLike[], today = "2026-11-02") =>
      reviewPlan({ people: [{ id: 1, name: "A", targetG: 100 }], dates: ["2026-11-02"], today, meals, rows, lookups }).cells[0]!.marker;
    const m = plannedMealsFrom([{ id: 1, date: "2026-11-02", slot: "lunch", recipeSlug: "dal", servings: { "1": 1 } }], [1]);
    expect(one(m, [row({ kind: "skipped", plannedRecipeSlug: "dal", recipeSlug: "dal", servings: 1 })])).toBe("skipped");
    expect(one([], [row({ ingredientSlug: "oats", grams: 10 })])).toBe("extras");
    expect(one([], [])).toBe("none");
    expect(one([], [], "2026-11-09")).toBe("none");
    const gone = plannedMealsFrom([{ id: 1, date: "2026-11-02", slot: "lunch", recipeSlug: "retired-recipe", servings: { "1": 1 } }], [1]);
    expect(reviewPlan({ people: [{ id: 1, name: "A", targetG: 100 }], dates: ["2026-11-02"], today: "2026-11-02", meals: gone, rows: [], lookups }).cells[0]!.plannedProteinG).toBe(0);
    expect(MARKER_TEXT.ate_plan).toBe("Ate as planned");
  });
});
