import type { DetailProps } from "@/components/RecipeDetail";
import type { DataSet } from "@/lib/data/load";
import type { IngredientCard } from "@/lib/filters/ingredients";
import type { RecipeCardData } from "@/lib/filters/recipes";
import { buildCandidates } from "@/lib/planner/candidates";
import { perServing, proteinByIngredient } from "@/lib/nutrition/macros";
import { autoTags } from "@/lib/nutrition/tags";
import { displayName } from "@/lib/schemas";
import { recipeDetailFromLibrary } from "./recipe-detail";

/**
 * Library-only loaders for visitors without an account. They take the loaded library files and nothing else: no
 * database, no household, no photos, no feedback, no links. Every household field is a fixed empty value.
 */
const NO_PHOTOS: ReadonlyMap<string, string> = new Map();

/** Search words for a recipe: every ingredient it uses (through its parts) and the tags its author wrote. */
export function recipeKeywords(slug: string, data: DataSet): string[] {
  const names = [...proteinByIngredient(slug, data.recipes, data.ingredients).keys()].map((k) => {
    const i = data.ingredients.get(k);
    return i ? [displayName(i), ...i.aliases] : [k];
  });
  return [...names.flat(), ...(data.recipes.get(slug)?.tags ?? [])];
}

const candidateCache = new WeakMap<DataSet, ReturnType<typeof buildCandidates>>();
const candidates = (data: DataSet) => {
  let c = candidateCache.get(data);
  if (!c) candidateCache.set(data, c = buildCandidates(data));
  return c;
};

export function libraryRecipeCards(data: DataSet): RecipeCardData[] {
  const meals = new Map(candidates(data).map((c) => [c.slug, c]));
  const cards: RecipeCardData[] = [];
  for (const r of data.recipes.values()) {
    if (r.kind === "routine") continue;
    const c = meals.get(r.slug);
    const m = c?.perServing ?? perServing(r.slug, data.recipes, data.ingredients);
    const base = { slug: r.slug, name: r.name, family: r.family, cuisine: r.cuisine, proteinG: m.protein_g, kcal: m.kcal, isIndian: r.is_indian, image: null, thumbs: [], favourite: false, tested: false, rating: null, banned: false, keywords: recipeKeywords(r.slug, data) };
    cards.push(c
      ? { ...base, kind: "recipe", slots: r.family === "shakes" ? ["shake"] : [...c.mealSlots], activeMin: c.activeMin, tags: autoTags(r, m, c.activeMin), lowSugar: c.lowSugar, light: c.light, dense: c.nutrientDense }
      : { ...base, kind: "component", slots: [], activeMin: r.active_min, tags: [], lowSugar: false, light: false, dense: false });
  }
  return cards;
}

export function libraryIngredientCards(data: DataSet): IngredientCard[] {
  return [...data.ingredients.values()].map((i) => ({
    slug: i.slug, name: displayName(i), aliases: i.aliases, aisle: i.aisle, state: i.state, image: null,
    kcal: i.per100g.kcal, proteinG: i.per100g.protein_g, carbsG: i.per100g.carbs_g, fatG: i.per100g.fat_g, fibreG: i.per100g.fibre_g,
    isDairy: i.is_dairy, onionGarlic: i.contains_onion_garlic,
  }));
}

/** The recipe page without feedback, photos, links or Make / Buy / Have choices. Null for a routine or an unknown slug. */
export function libraryRecipeDetail(data: DataSet, slug: string): DetailProps | null {
  const r = data.recipes.get(slug);
  if (!r || r.kind === "routine") return null;
  const dense = candidates(data).find((c) => c.slug === slug)?.nutrientDense ?? false;
  return {
    ...recipeDetailFromLibrary(data, slug, { sex: "other", targetLabel: "adult reference values", ingredientPhotos: NO_PHOTOS, dense }),
    image: null,
    photos: [],
    feedback: { favourite: false, banned: false, rating: null, tested: false },
    earlierFeedback: null,
    partModes: {},
    planId: null,
    links: [],
    mode: "anonymous",
  };
}

/** Highest-protein meals, for the signed-out landing page. */
export function libraryHighlights(data: DataSet, count = 6): RecipeCardData[] {
  return libraryRecipeCards(data)
    .filter((r) => r.kind === "recipe" && r.tags.includes("high-protein"))
    .sort((a, b) => b.proteinG / Math.max(b.kcal, 1) - a.proteinG / Math.max(a.kcal, 1) || a.name.localeCompare(b.name))
    .slice(0, count);
}

/** Props for the ingredient page without photos or profile-based reference values. */
export function libraryIngredientDetail(data: DataSet, slug: string) {
  return { data, slug, sex: "other" as const, cover: undefined, recipePhotos: NO_PHOTOS, ingredientPhotos: NO_PHOTOS, anonymous: true };
}
