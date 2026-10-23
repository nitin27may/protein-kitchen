import { describe, expect, it } from "vitest";
import { dietFlagProblems, habitProblems, missingSoak, missingTechniqueLinks, needsCookedYield } from "../lib/data/rules";
import type { Ingredient, Recipe } from "../lib/schemas";

const base: Ingredient = {
  slug: "test-item",
  name: "Test item",
  aliases: [],
  state: "dry",
  per100g: { kcal: 350, protein_g: 20, carbs_g: 60, fat_g: 1, fibre_g: 10 },
  source: "CNF",
  source_id: "1",
  aisle: "legumes",
  pack_size_g: null,
  where_to_buy: [],
  is_pantry_staple: false,
  contains_onion_garlic: false,
  is_dairy: false,
};

const recipeBase: Recipe = {
  slug: "r",
  name: "r",
  kind: "recipe",
  family: "f",
  meal_slots: ["dinner"],
  cuisine: "x",
  is_indian: false,
  servings: 2,
  prep_min: 0,
  active_min: 10,
  total_min: 10,
  equipment: [],
  tags: [],
  fridge_days: 1,
  status: "draft",
  items: [{ ingredient: "chickpeas-dry", grams: 100 }],
  advance_prep: [],
  steps: [{ text: "cook" }],
};

describe("needsCookedYield", () => {
  it("requires a yield for dry legumes", () => {
    expect(needsCookedYield(base, {})).toBe(true);
  });
  it("is satisfied by a yield or an exemption", () => {
    expect(needsCookedYield({ ...base, cooked_yield: 2.4 }, {})).toBe(false);
    expect(needsCookedYield(base, { "test-item": "flour" })).toBe(false);
  });
  it("ignores non-dry states", () => {
    expect(needsCookedYield({ ...base, state: "cooked" }, {})).toBe(false);
  });
});

describe("dietFlagProblems", () => {
  it("flags forbidden terms", () => {
    expect(dietFlagProblems({ ...base, name: "Chicken stock powder" })).not.toHaveLength(0);
  });
  it("does not flag eggplant", () => {
    expect(dietFlagProblems({ ...base, name: "Eggplant, raw", slug: "eggplant" })).toHaveLength(0);
  });
  it("requires the onion and garlic flag", () => {
    expect(dietFlagProblems({ ...base, slug: "garlic", name: "Garlic" })).not.toHaveLength(0);
    expect(dietFlagProblems({ ...base, slug: "garlic", name: "Garlic", contains_onion_garlic: true })).toHaveLength(0);
  });
  it("requires is_dairy in the dairy aisle", () => {
    expect(dietFlagProblems({ ...base, aisle: "dairy" })).not.toHaveLength(0);
  });
});

describe("recipe rules", () => {
  it("reports a missing soak", () => {
    expect(missingSoak(recipeBase)).toEqual(["chickpeas-dry"]);
    expect(
      missingSoak({ ...recipeBase, advance_prep: [{ kind: "soak", ingredient: "chickpeas-dry", lead_hours: 8, instruction: "soak" }] }),
    ).toEqual([]);
  });
  it("requires a technique link on non-Indian recipes only", () => {
    expect(missingTechniqueLinks(recipeBase)).toBe(true);
    expect(missingTechniqueLinks({ ...recipeBase, steps: [{ text: "x", technique: "oven-basics" }] })).toBe(false);
    expect(missingTechniqueLinks({ ...recipeBase, is_indian: true })).toBe(false);
  });
});

describe("habitProblems", () => {
  const habit = {
    slug: "x",
    title: "Test",
    category: "daily_basic" as const,
    evidence_grade: "practical" as const,
    evidence_note: "Makes cooking easier.",
    source_url: null,
    caution: null,
    default_on: true,
  };
  it("accepts a practical habit without a source", () => {
    expect(habitProblems(habit)).toEqual([]);
  });
  it("requires a source for strong and moderate grades", () => {
    expect(habitProblems({ ...habit, evidence_grade: "strong" })).not.toHaveLength(0);
    expect(habitProblems({ ...habit, evidence_grade: "moderate" })).not.toHaveLength(0);
    expect(habitProblems({ ...habit, evidence_grade: "strong", source_url: "https://example.org/a" })).toEqual([]);
  });
  it("rejects supplement-style doses", () => {
    expect(habitProblems({ ...habit, evidence_note: "Take 2000 IU daily." })).not.toHaveLength(0);
    expect(habitProblems({ ...habit, evidence_note: "Soak for 8 hours, use 1 tbsp." })).toEqual([]);
  });
});
