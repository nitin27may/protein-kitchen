import type { DetailProps } from "@/components/RecipeDetail";
import type { DataSet } from "@/lib/data/load";
import type { IngredientCard } from "@/lib/filters/ingredients";
import type { RecipeCardData } from "@/lib/filters/recipes";
import { EMPTY_LIBRARY_MANIFEST, libraryCoverUrls, libraryCreditLines, libraryViews, type LibraryPhotoManifest } from "@/lib/library-photos/model";
import type { CreditedPhoto } from "@/lib/photos/view";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { buildCandidates } from "@/lib/planner/candidates";
import { perServing, proteinByIngredient } from "@/lib/nutrition/macros";
import { autoTags } from "@/lib/nutrition/tags";
import { displayName } from "@/lib/schemas";
import { recipeDetailFromLibrary } from "./recipe-detail";

/**
 * Library-only loaders for visitors without an account. They take the loaded library files and nothing else: no
 * database, no household, no feedback, no links. Every household field is a fixed empty value. Photos come only from the
 * library manifest the page passes in (approved library photos, the same for everyone); without one there are none.
 */
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

export function libraryRecipeCards(data: DataSet, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): RecipeCardData[] {
  const covers = libraryCoverUrls(manifest, "recipe");
  const ingredientCovers = libraryCoverUrls(manifest, "ingredient");
  const meals = new Map(candidates(data).map((c) => [c.slug, c]));
  const cards: RecipeCardData[] = [];
  for (const r of data.recipes.values()) {
    if (r.kind === "routine") continue;
    const c = meals.get(r.slug);
    const m = c?.perServing ?? perServing(r.slug, data.recipes, data.ingredients);
    const base = { slug: r.slug, name: r.name, family: r.family, cuisine: r.cuisine, proteinG: m.protein_g, kcal: m.kcal, isIndian: r.is_indian, image: covers.get(r.slug) ?? null, thumbs: c && ingredientCovers.size ? recipeThumbs(r.slug, data.recipes, data.ingredients, ingredientCovers) : [], favourite: false, tested: false, rating: null, banned: false, keywords: recipeKeywords(r.slug, data) };
    cards.push(c
      ? { ...base, kind: "recipe", slots: r.family === "shakes" ? ["shake"] : [...c.mealSlots], activeMin: c.activeMin, tags: autoTags(r, m, c.activeMin), lowSugar: c.lowSugar, light: c.light, dense: c.nutrientDense }
      : { ...base, kind: "component", slots: [], activeMin: r.active_min, tags: [], lowSugar: false, light: false, dense: false });
  }
  return cards;
}

export function libraryIngredientCards(data: DataSet, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): IngredientCard[] {
  const covers = libraryCoverUrls(manifest, "ingredient");
  return [...data.ingredients.values()].map((i) => ({
    slug: i.slug, name: displayName(i), aliases: i.aliases, aisle: i.aisle, state: i.state, image: covers.get(i.slug) ?? null,
    kcal: i.per100g.kcal, proteinG: i.per100g.protein_g, carbsG: i.per100g.carbs_g, fatG: i.per100g.fat_g, fibreG: i.per100g.fibre_g,
    isDairy: i.is_dairy, onionGarlic: i.contains_onion_garlic,
  }));
}

/** The recipe page without feedback, photos, links or Make / Buy / Have choices. Null for a routine or an unknown slug. */
export function libraryRecipeDetail(data: DataSet, slug: string, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): DetailProps | null {
  const r = data.recipes.get(slug);
  if (!r || r.kind === "routine") return null;
  const dense = candidates(data).find((c) => c.slug === slug)?.nutrientDense ?? false;
  const photos = libraryViews(manifest, "recipe", slug);
  return {
    ...recipeDetailFromLibrary(data, slug, { sex: "other", targetLabel: "adult reference values", ingredientPhotos: libraryCoverUrls(manifest, "ingredient"), dense }),
    image: photos.find((p) => p.isCover)?.url ?? null,
    photos,
    feedback: { favourite: false, banned: false, rating: null, tested: false },
    earlierFeedback: null,
    partModes: {},
    planId: null,
    links: [],
    mode: "anonymous",
  };
}

/** Highest-protein meals, for the signed-out landing page. */
export function libraryHighlights(data: DataSet, count = 6, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): RecipeCardData[] {
  return libraryRecipeCards(data, manifest)
    .filter((r) => r.kind === "recipe" && r.tags.includes("high-protein"))
    .sort((a, b) => b.proteinG / Math.max(b.kcal, 1) - a.proteinG / Math.max(a.kcal, 1) || a.name.localeCompare(b.name))
    .slice(0, count);
}

/** Props for the ingredient page without photos or profile-based reference values. */
export function libraryIngredientDetail(data: DataSet, slug: string, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST) {
  return {
    data, slug, sex: "other" as const,
    cover: libraryViews(manifest, "ingredient", slug).find((p) => p.isCover),
    recipePhotos: libraryCoverUrls(manifest, "recipe"), ingredientPhotos: libraryCoverUrls(manifest, "ingredient"), anonymous: true,
  };
}

/** Public credit lines for the library photos whose recipe or ingredient is still in the library, with display names. */
export function libraryCredits(data: DataSet, manifest: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): (CreditedPhoto & { name: string })[] {
  return creditsWithNames(data, libraryCreditLines(manifest));
}

/** Adds the display name of each credited subject and sorts by name. A subject that left the library keeps its slug as the name. */
export function creditsWithNames(data: DataSet, lines: CreditedPhoto[]): (CreditedPhoto & { name: string })[] {
  const name = (l: CreditedPhoto) => l.subjectKind === "recipe" ? (data.recipes.get(l.subjectSlug)?.name ?? l.subjectSlug) : (data.ingredients.get(l.subjectSlug) ? displayName(data.ingredients.get(l.subjectSlug)!) : l.subjectSlug);
  return lines.map((l) => ({ ...l, name: name(l) })).sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
}
