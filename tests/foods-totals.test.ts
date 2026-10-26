import { describe, expect, it } from "vitest";
import {
  computeDays,
  computeDayTotals,
  emptyTotals,
  markRestAsEaten,
  type LoggedEntry,
  type NutrientsPer,
  type NutritionLookups,
  type PlannedMeal,
} from "@/lib/foods/totals";

const foods: Record<string, NutrientsPer> = {
  "hf:pancake": { kcal: 345, protein_g: 7.3, carbs_g: 72.7, fat_g: 1.8 }, // fibre not reported
  "oats-rolled": { kcal: 380, protein_g: 13, carbs_g: 68, fat_g: 7, fibre_g: 10 },
};
const recipes: Record<string, NutrientsPer> = {
  "dal-bowl": { kcal: 500, protein_g: 28, carbs_g: 70, fat_g: 10, fibre_g: 12 },
  "fruit-lassi": { kcal: 200, protein_g: 8, carbs_g: 30, fat_g: 4 }, // fibre not reported
};
const lookups: NutritionLookups = { food: (k) => foods[k], recipePerServing: (s) => recipes[s] };

const today = "2026-10-26";
const meal = (key: string, recipe: string, over: Partial<PlannedMeal> = {}): PlannedMeal => ({ key, personId: "p1", date: today, slot: "lunch", recipe, servings: 1, ...over });
const entry = (id: string, over: Partial<LoggedEntry>): LoggedEntry => ({ id, personId: "p1", date: today, kind: "extra", ...over });
const day = (meals: PlannedMeal[], entries: LoggedEntry[], over: { date?: string; today?: string } = {}) =>
  computeDayTotals({ personId: "p1", date: over.date ?? today, today: over.today ?? today, meals, entries, lookups });

describe("eaten", () => {
  it("sums food entries by grams: the pancake mix logged at 110 g", () => {
    const d = day([], [entry("e1", { foodKey: "hf:pancake", grams: 110 })]);
    expect(d.status).toBe("logged");
    expect(d.eaten?.kcal).toBeCloseTo(379.5);
    expect(d.eaten?.protein_g).toBeCloseTo(8.03);
  });
  it("sums recipe entries by servings, across kinds", () => {
    const d = day(
      [meal("m1", "dal-bowl"), meal("m2", "dal-bowl", { slot: "dinner" })],
      [
        entry("e1", { kind: "planned", plannedKey: "m1", recipe: "dal-bowl", servings: 1.5 }),
        entry("e2", { kind: "swap", plannedKey: "m2", foodKey: "oats-rolled", grams: 50 }),
        entry("e3", { kind: "extra", recipe: "dal-bowl", servings: 0.5 }),
      ],
    );
    expect(d.eaten?.kcal).toBeCloseTo(750 + 190 + 250);
    expect(d.eaten?.protein_g).toBeCloseTo(42 + 6.5 + 14);
    expect(d.plannedPendingKeys).toEqual([]);
    expect(d.unresolvedEntryIds).toEqual([]);
  });
  it("a skipped meal adds nothing and is answered", () => {
    const d = day([meal("m1", "dal-bowl")], [entry("e1", { kind: "skipped", plannedKey: "m1" })]);
    expect(d.status).toBe("logged");
    expect(d.eaten).toEqual(emptyTotals());
    expect(d.skippedKeys).toEqual(["m1"]);
    expect(d.plannedPendingKeys).toEqual([]);
  });
  it("a skipped entry without a planned key is harmless", () => {
    const d = day([], [entry("e1", { kind: "skipped" })]);
    expect(d.skippedKeys).toEqual([]);
  });
  it("ignores other people and other days", () => {
    const d = day([], [entry("e1", { personId: "p2", foodKey: "oats-rolled", grams: 100 }), entry("e2", { date: "2026-10-25", foodKey: "oats-rolled", grams: 100 })]);
    expect(d.status).toBe("open");
    expect(d.eaten).toEqual(emptyTotals());
  });
  it("leaves unresolvable entries out and reports them", () => {
    const d = day([], [
      entry("a", { foodKey: "hf:unknown", grams: 100 }),
      entry("b", { foodKey: "oats-rolled" }),
      entry("c", { foodKey: "oats-rolled", grams: 0 }),
      entry("d", { recipe: "ghost", servings: 1 }),
      entry("e", { recipe: "dal-bowl" }),
      entry("f", { recipe: "dal-bowl", servings: Number.NaN }),
      entry("g", {}),
    ]);
    expect(d.unresolvedEntryIds).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(d.eaten).toEqual(emptyTotals());
  });
});

describe("fibre not reported", () => {
  it("is a floor with a count, never zero-assumed", () => {
    const d = day([], [
      entry("e1", { foodKey: "oats-rolled", grams: 100 }),
      entry("e2", { foodKey: "hf:pancake", grams: 110 }),
      entry("e3", { recipe: "fruit-lassi", servings: 1 }),
    ]);
    expect(d.eaten?.fibre_g).toBeCloseTo(10);
    expect(d.eaten?.fibre_at_least).toBe(true);
    expect(d.eaten?.fibre_not_reported_count).toBe(2);
  });
  it("is exact when every item reports fibre", () => {
    const d = day([], [entry("e1", { foodKey: "oats-rolled", grams: 100 })]);
    expect(d.eaten?.fibre_at_least).toBe(false);
    expect(d.eaten?.fibre_not_reported_count).toBe(0);
  });
  it("applies to planned-pending too", () => {
    const d = day([meal("m1", "fruit-lassi")], []);
    expect(d.plannedPending.fibre_at_least).toBe(true);
    expect(d.plannedPending.fibre_not_reported_count).toBe(1);
  });
});

describe("planned, not confirmed", () => {
  it("lists meals with no entry and their macros, scaled by servings", () => {
    const d = day([meal("m1", "dal-bowl", { servings: 2 }), meal("m2", "fruit-lassi")], [entry("e1", { kind: "planned", plannedKey: "m2", recipe: "fruit-lassi", servings: 1 })]);
    expect(d.plannedPendingKeys).toEqual(["m1"]);
    expect(d.plannedPending.kcal).toBe(1000);
    expect(d.eaten?.kcal).toBe(200);
  });
  it("a meal whose recipe cannot be looked up is still listed but adds nothing", () => {
    const d = day([meal("m1", "ghost")], []);
    expect(d.plannedPendingKeys).toEqual(["m1"]);
    expect(d.plannedPending).toEqual(emptyTotals());
  });
  it("only counts this person's meals on this day", () => {
    const d = day([meal("m1", "dal-bowl", { personId: "p2" }), meal("m2", "dal-bowl", { date: "2026-10-27" })], []);
    expect(d.plannedPendingKeys).toEqual([]);
  });
});

describe("status", () => {
  it("a past day with no entries is not logged, never assumed eaten", () => {
    const d = day([meal("m1", "dal-bowl", { date: "2026-10-24" })], [], { date: "2026-10-24" });
    expect(d.status).toBe("not_logged");
    expect(d.eaten).toBeNull();
    expect(d.plannedPendingKeys).toEqual(["m1"]);
  });
  it("today and future days with no entries are open", () => {
    expect(day([], []).status).toBe("open");
    expect(day([], [], { date: "2026-10-30" }).status).toBe("open");
  });
  it("a past day with an entry is logged", () => {
    const d = day([], [entry("e1", { date: "2026-10-24", foodKey: "oats-rolled", grams: 40 })], { date: "2026-10-24" });
    expect(d.status).toBe("logged");
    expect(d.eaten?.protein_g).toBeCloseTo(5.2);
  });
});

describe("computeDays", () => {
  it("one row per person per day, dates ascending", () => {
    const rows = computeDays({ today, personIds: ["p1", "p2"], dates: ["2026-10-26", "2026-10-24"], meals: [], entries: [entry("e1", { personId: "p2", foodKey: "oats-rolled", grams: 10 })], lookups });
    expect(rows.map((r) => [r.personId, r.date, r.status])).toEqual([
      ["p1", "2026-10-24", "not_logged"],
      ["p1", "2026-10-26", "open"],
      ["p2", "2026-10-24", "not_logged"],
      ["p2", "2026-10-26", "logged"],
    ]);
  });
});

describe("markRestAsEaten", () => {
  it("returns drafts only for unanswered planned meals of that person and day", () => {
    const meals = [meal("m1", "dal-bowl"), meal("m2", "fruit-lassi", { slot: "snack", servings: 2 }), meal("m3", "dal-bowl", { slot: "dinner" }), meal("m4", "dal-bowl", { personId: "p2" }), meal("m5", "dal-bowl", { date: "2026-10-27" })];
    const entries = [entry("e1", { kind: "swap", plannedKey: "m1", foodKey: "oats-rolled", grams: 50 }), entry("e2", { kind: "skipped", plannedKey: "m3" }), entry("e3", { personId: "p2", kind: "planned", plannedKey: "m4", recipe: "dal-bowl", servings: 1 }), entry("e4", {})];
    expect(markRestAsEaten({ personId: "p1", date: today, meals, entries })).toEqual([
      { personId: "p1", date: today, kind: "planned", plannedKey: "m2", recipe: "fruit-lassi", servings: 2 },
    ]);
    expect(markRestAsEaten({ personId: "p2", date: today, meals, entries: [] })).toHaveLength(1);
  });
  it("is empty when everything is answered", () => {
    expect(markRestAsEaten({ personId: "p1", date: today, meals: [meal("m1", "dal-bowl")], entries: [entry("e", { kind: "skipped", plannedKey: "m1" })] })).toEqual([]);
  });
});
