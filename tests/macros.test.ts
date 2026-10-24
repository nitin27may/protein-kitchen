import { describe, expect, it } from "vitest";
import {
  anchorIngredients,
  atwaterKcal,
  CycleError,
  cookedToDry,
  dryToCooked,
  ingredientMacros,
  kcalDeviationOk,
  perServing,
  recipeTotals,
  UnknownReferenceError,
} from "../lib/nutrition/macros";
import { autoTags } from "../lib/nutrition/tags";
import type { Ingredient, Recipe } from "../lib/schemas";

const ing = (slug: string, per100g: Ingredient["per100g"], extra: Partial<Ingredient> = {}): Ingredient => ({
  slug,
  name: slug,
  aliases: [],
  state: "ready",
  per100g,
  source: "CNF",
  source_id: "1",
  aisle: "test",
  pack_size_g: null,
  where_to_buy: [],
  is_pantry_staple: false,
  contains_onion_garlic: false,
  is_dairy: false,
  ...extra,
});

const recipe = (slug: string, kind: Recipe["kind"], items: Recipe["items"], servings = 1, extra: Partial<Recipe> = {}): Recipe => ({
  slug,
  name: slug,
  kind,
  family: "test",
  meal_slots: ["dinner"],
  cuisine: "test",
  is_indian: true,
  servings,
  prep_min: 0,
  active_min: 10,
  total_min: 10,
  equipment: [],
  tags: [],
  fridge_days: 1,
  status: "draft",
  items,
  advance_prep: [],
  steps: [{ text: "x" }],
  ...extra,
});

const paneer = ing("paneer", { kcal: 305, protein_g: 18.9, carbs_g: 2.4, fat_g: 24.8, fibre_g: 0 });
const oil = ing("oil", { kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, fibre_g: 0 });
const ingredients = new Map([paneer, oil].map((i) => [i.slug, i]));

describe("ingredientMacros", () => {
  it("scales per-100g values to the weighed grams", () => {
    const m = ingredientMacros(paneer, 250);
    expect(m.protein_g).toBeCloseTo(47.25, 5);
    expect(m.kcal).toBeCloseTo(762.5, 5);
  });
});

describe("dry and cooked conversion", () => {
  it("round-trips through the cooked yield", () => {
    expect(dryToCooked(100, 2.4)).toBeCloseTo(240);
    expect(cookedToDry(240, 2.4)).toBeCloseTo(100);
  });
});

describe("kcal check", () => {
  it("accepts a value consistent with the macros", () => {
    expect(kcalDeviationOk(paneer.per100g)).toBe(true);
  });
  it("counts fibre at 2 kcal per gram", () => {
    const spinach = { kcal: 23, protein_g: 2.9, carbs_g: 3.6, fat_g: 0.4, fibre_g: 2.2 };
    expect(atwaterKcal(spinach)).toBeCloseTo(4 * 2.9 + 4 * 1.4 + 2 * 2.2 + 9 * 0.4, 5);
    expect(kcalDeviationOk(spinach)).toBe(true);
  });
  it("rejects a clearly wrong kcal value", () => {
    expect(kcalDeviationOk({ kcal: 50, protein_g: 20, carbs_g: 10, fat_g: 10, fibre_g: 0 })).toBe(false);
  });
});

describe("recipeTotals and perServing", () => {
  it("sums ingredients and divides by servings", () => {
    const r = recipe("bhurji", "recipe", [{ ingredient: "paneer", grams: 200 }, { ingredient: "oil", grams: 10 }], 2);
    const recipes = new Map([[r.slug, r]]);
    const m = perServing("bhurji", recipes, ingredients);
    expect(m.protein_g).toBeCloseTo((18.9 * 2) / 2, 5);
    expect(m.fat_g).toBeCloseTo((24.8 * 2 + 10) / 2, 5);
  });

  it("uses a component's per-gram rate", () => {
    const sauce = recipe("sauce", "component", [{ ingredient: "paneer", grams: 100 }, { ingredient: "oil", grams: 100 }]);
    const dish = recipe("dish", "recipe", [{ component: "sauce", grams: 50 }]);
    const recipes = new Map([sauce, dish].map((r) => [r.slug, r]));
    const m = perServing("dish", recipes, ingredients);
    // sauce is half paneer by weight, 50 g of it holds 25 g paneer
    expect(m.protein_g).toBeCloseTo(18.9 * 0.25, 5);
  });

  it("throws on a component cycle", () => {
    const a = recipe("a", "component", [{ component: "b", grams: 10 }]);
    const b = recipe("b", "component", [{ component: "a", grams: 10 }]);
    const recipes = new Map([a, b].map((r) => [r.slug, r]));
    expect(() => recipeTotals("a", recipes, ingredients)).toThrow(CycleError);
  });

  it("throws on an unknown ingredient", () => {
    const r = recipe("r", "recipe", [{ ingredient: "missing", grams: 10 }]);
    expect(() => recipeTotals("r", new Map([[r.slug, r]]), ingredients)).toThrow(UnknownReferenceError);
  });

  it("rejects using a recipe where a component is expected", () => {
    const inner = recipe("inner", "recipe", [{ ingredient: "paneer", grams: 100 }]);
    const outer = recipe("outer", "recipe", [{ component: "inner", grams: 50 }]);
    const recipes = new Map([inner, outer].map((r) => [r.slug, r]));
    expect(() => recipeTotals("outer", recipes, ingredients)).toThrow(UnknownReferenceError);
  });
});

describe("autoTags", () => {
  it("uses the effective hands-on time when given, so parts made fresh stop a meal being quick", () => {
    expect(autoTags({ meal_slots: ["dinner"], active_min: 10 }, macros)).toContain("quick");
    expect(autoTags({ meal_slots: ["dinner"], active_min: 10 }, macros, 30)).not.toContain("quick");
  });

  const macros = { kcal: 400, protein_g: 32, carbs_g: 20, fat_g: 10, fibre_g: 9 };
  it("tags a high-protein dinner", () => {
    expect(autoTags({ meal_slots: ["dinner"], active_min: 25 }, macros)).toEqual(["high-protein", "protein-dense", "high-fibre"]);
  });
  it("uses the breakfast threshold of 20 g", () => {
    const tags = autoTags({ meal_slots: ["breakfast"], active_min: 10 }, { ...macros, protein_g: 21 });
    expect(tags).toContain("high-protein");
    expect(tags).toContain("quick");
  });
  it("does not tag a 22 g dinner as high-protein", () => {
    expect(autoTags({ meal_slots: ["dinner"], active_min: 25 }, { ...macros, protein_g: 22 })).not.toContain("high-protein");
  });
});

describe("anchorIngredients", () => {
  it("returns the ingredients supplying most protein, through components", () => {
    const sauce = recipe("sauce", "component", [{ ingredient: "paneer", grams: 100 }, { ingredient: "oil", grams: 100 }]);
    const dish = recipe("dish", "recipe", [{ component: "sauce", grams: 100 }, { ingredient: "oil", grams: 5 }]);
    const recipes = new Map([sauce, dish].map((r) => [r.slug, r]));
    expect(anchorIngredients("dish", recipes, ingredients)).toEqual(["paneer"]);
  });
});
