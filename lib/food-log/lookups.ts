import { CycleError, UnknownReferenceError, perServing, type RecipeTotals } from "../nutrition/macros";
import type { Ingredient, Recipe } from "../schemas";
import type { NutrientsPer, NutritionLookups } from "../foods/totals";
import { HOUSEHOLD_PREFIX } from "../foods/catalog";

/** What a household food contributes: per 100 g, with fibre null when the label does not report it. */
export interface HouseholdFoodNutrition {
  uid: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number | null;
}

export function householdPer100(f: HouseholdFoodNutrition): NutrientsPer {
  const n: NutrientsPer = { kcal: f.kcal, protein_g: f.proteinG, carbs_g: f.carbsG, fat_g: f.fatG };
  if (f.fibreG !== null) n.fibre_g = f.fibreG;
  return n;
}

/**
 * Nutrition for totals, computed from library data plus the household's own foods. Macros are never stored on an entry.
 * An unknown key or recipe resolves to undefined, and totals report that entry as unresolved.
 */
export function nutritionLookups(
  recipes: ReadonlyMap<string, Recipe>,
  ingredients: ReadonlyMap<string, Ingredient>,
  foods: readonly HouseholdFoodNutrition[],
): NutritionLookups {
  const byUid = new Map(foods.map((f) => [f.uid, f]));
  const memo = new Map<string, RecipeTotals>();
  return {
    food(key) {
      if (key.startsWith(HOUSEHOLD_PREFIX)) {
        const f = byUid.get(key.slice(HOUSEHOLD_PREFIX.length));
        return f ? householdPer100(f) : undefined;
      }
      return ingredients.get(key)?.per100g;
    },
    recipePerServing(slug) {
      try {
        return perServing(slug, recipes, ingredients, memo);
      } catch (error) {
        if (error instanceof UnknownReferenceError || error instanceof CycleError) return undefined;
        throw error;
      }
    },
  };
}
