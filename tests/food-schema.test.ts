import { describe, expect, it } from "vitest";
import { FOOD_MICRO_KEYS, FoodLogEntryInput, FoodLogEntryUpdate, HouseholdFoodInput } from "../lib/schemas/food";

const base = { name: " Oat bar ", kcal: 400, proteinG: 10, carbsG: 60, fatG: 12, labelBasis: "per_100g", source: "LABEL" } as const;

describe("household food input", () => {
  it("fills defaults, trims text and turns missing optional values into null", () => {
    expect(HouseholdFoodInput.parse(base)).toMatchObject({
      name: "Oat bar", brand: null, barcode: null, state: "ready", aisle: "packaged", fibreG: null, per100gMicros: {}, notReported: [],
      servingG: null, servingMl: null, densityGPerMl: null, pieceG: null, labelValues: {}, fieldOrigins: {}, isDairy: false,
      containsOnionGarlic: false, dietFlagsFound: [], dietCheckedAt: null, ingredientsText: null, sourceId: null,
    });
  });

  it("keeps a reported zero fibre distinct from not reported", () => {
    expect(HouseholdFoodInput.parse({ ...base, fibreG: 0 }).fibreG).toBe(0);
    expect(HouseholdFoodInput.parse({ ...base, fibreG: null }).fibreG).toBeNull();
  });

  it.each([
    ["negative nutrient", { kcal: -1 }], ["non-finite", { proteinG: Infinity }], ["blank name", { name: "  " }], ["bad barcode", { barcode: "123" }],
    ["unknown source", { source: "GUESS" }], ["unknown state", { state: "frozen" }], ["unknown basis", { labelBasis: "per_pack" }],
    ["zero serving", { servingG: 0 }], ["unknown micro key", { per100gMicros: { magic_mg: 1 } }], ["negative micro", { per100gMicros: { calcium_mg: -1 } }],
    ["unknown not-reported key", { notReported: ["magic_mg"] }], ["bad timestamp", { dietCheckedAt: "yesterday" }],
  ])("rejects %s", (_name, over) => {
    expect(HouseholdFoodInput.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it("accepts every micronutrient key the library uses", () => {
    expect(FOOD_MICRO_KEYS).toContain("calcium_mg");
    expect(HouseholdFoodInput.safeParse({ ...base, per100gMicros: Object.fromEntries(FOOD_MICRO_KEYS.map((k) => [k, 1])) }).success).toBe(true);
  });
});

describe("food log entry input", () => {
  const entry = { personId: 1, date: "2026-11-02", slot: "lunch", kind: "extra" } as const;

  it("takes exactly one item shape", () => {
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } }).success).toBe(true);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "ingredient", ingredientSlug: "lentils-dry", grams: 40 } }).success).toBe(true);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "food", householdFoodUid: "u", grams: 40 } }).success).toBe(true);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "recipe", recipeSlug: "dal-tadka", grams: 1 } }).success).toBe(false);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "food", householdFoodUid: "u", servings: 1 } }).success).toBe(false);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "ingredient", ingredientSlug: "Bad Slug", grams: 5 } }).success).toBe(false);
    expect(FoodLogEntryInput.safeParse({ ...entry, item: { type: "recipe", recipeSlug: "dal-tadka", servings: 0 } }).success).toBe(false);
  });

  it.each([["slot", { slot: "brunch" }], ["kind", { kind: "maybe" }], ["date", { date: "02/11/2026" }], ["person", { personId: 0 }]])("rejects a bad %s", (_n, over) => {
    expect(FoodLogEntryInput.safeParse({ ...entry, ...over, item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 } }).success).toBe(false);
  });

  it("an update has no person and defaults the plan link and notes to null", () => {
    const parsed = FoodLogEntryUpdate.parse({ date: "2026-11-02", slot: "snack", kind: "swap", item: { type: "recipe", recipeSlug: "dal-tadka", servings: 1 }, note: "  " });
    expect(parsed).toMatchObject({ planId: null, plannedRecipeSlug: null, displayQty: null });
    expect("personId" in parsed).toBe(false);
  });
});
