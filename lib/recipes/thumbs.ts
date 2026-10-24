import { expandRecipe } from "../grocery/aggregate";
import type { Ingredient, Recipe } from "../schemas";

/** Seasonings and fats carry little visual identity, so they never headline a recipe collage. */
const SKIP_AISLES = new Set(["spices", "oils", "fats", "pantry", "supplements"]);

/** A collage needs at least this many ingredient photos; fewer say too little about the dish. */
export const MIN_COLLAGE_PHOTOS = 3;

/**
 * Photo URLs of the recipe's heaviest ingredients (from `photoIndex`), for the collage shown when the recipe has no photo of its own.
 * Empty when fewer than `MIN_COLLAGE_PHOTOS` are available.
 */
export function recipeThumbs(slug: string, recipes: ReadonlyMap<string, Recipe>, ingredients: ReadonlyMap<string, Ingredient>, urls: ReadonlyMap<string, string>, max = 4): string[] {
  const recipe = recipes.get(slug);
  if (!recipe) return [];
  let grams: Map<string, number>;
  try {
    grams = expandRecipe(slug, recipe.servings, recipes);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const photos = [...grams.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([k]) => {
      const ing = ingredients.get(k);
      const url = urls.get(k);
      return url && ing && !SKIP_AISLES.has(ing.aisle) ? [url] : [];
    })
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)))
    .slice(0, max);
  return photos.length >= MIN_COLLAGE_PHOTOS ? photos : [];
}
