import type { Ingredient, MicrosFile, Recipe } from "../schemas";
import { expandRecipe } from "../grocery/aggregate";

export interface NutrientAmount {
  key: string;
  amount: number;
  /** Ingredients that contributed grams but had no value for this nutrient. Their share is missing, so the amount is a floor. */
  missingFrom: string[];
}

/**
 * Micronutrients per serving. A value that the source did not report is not treated as zero:
 * those ingredients are listed in `missingFrom`, and the amount is then a lower bound.
 */
export function microsPerServing(
  slug: string,
  recipes: ReadonlyMap<string, Recipe>,
  ingredients: ReadonlyMap<string, Ingredient>,
  micros: MicrosFile,
  keys: readonly string[],
): NutrientAmount[] {
  const grams = expandRecipe(slug, recipes.get(slug)?.servings ?? 1, recipes);
  const servings = recipes.get(slug)?.servings ?? 1;
  return keys.map((key) => {
    let total = 0;
    const missing: string[] = [];
    for (const [ing, g] of grams) {
      if (!ingredients.has(ing)) continue;
      const entry = micros[ing];
      const v = entry?.per100g[key];
      if (v === undefined) {
        if (g >= 5) missing.push(ing);
        continue;
      }
      total += (v * g) / 100;
    }
    return { key, amount: total / servings, missingFrom: missing };
  });
}
