import { expandRecipe } from "../grocery/aggregate";
import type { Ingredient, Recipe } from "../schemas";

/** Seasonings and fats carry little visual identity, so they never headline a recipe collage. */
const SKIP_AISLES = new Set(["spices", "oils", "fats", "pantry", "supplements"]);

/** Photo file names of the recipe's heaviest ingredients, for the collage shown when the recipe has no photo of its own. */
export function recipeThumbs(slug: string, recipes: ReadonlyMap<string, Recipe>, ingredients: ReadonlyMap<string, Ingredient>, max = 4): string[] {
  const recipe = recipes.get(slug);
  if (!recipe) return [];
  let grams: Map<string, number>;
  try {
    grams = expandRecipe(slug, recipe.servings, recipes);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return [...grams.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([k]) => {
      const ing = ingredients.get(k);
      return ing?.image && !SKIP_AISLES.has(ing.aisle) ? [ing.image] : [];
    })
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)))
    .slice(0, max);
}
