import { displayName } from "../schemas";
import type { Ingredient, Recipe } from "../schemas";
import { UnknownReferenceError } from "../nutrition/macros";
import type { PartModes } from "../parts/mode";
import { resolverFor } from "../parts/resolve";
import type { PartResolver } from "../parts/resolve";

export type { PartMode } from "../parts/mode";
export type { PartResolver } from "../parts/resolve";

/** The parts of a recipe the grocery maths reads, so a trimmed library payload can stand in for the full one. */
export type GroceryRecipe = Pick<Recipe, "servings" | "items">;
export type GroceryIngredient = Pick<Ingredient, "name" | "display_name" | "aisle" | "state" | "pack_size_g" | "is_pantry_staple">;

export interface PlanMealRef {
  recipeSlug: string;
  /** Total servings cooked for this meal, across everyone eating it. */
  servings: number;
}

export interface GroceryLine {
  ingredient: string;
  name: string;
  aisle: string;
  state: Ingredient["state"];
  grams: number;
  /** Rounded up for shopping: whole packs when the pack size is known, otherwise the next 10 g. */
  buyGrams: number;
  packs: number | null;
  isPantryStaple: boolean;
  /** Recipes that need this ingredient, for informed removal. */
  recipes: string[];
}

export interface GroceryList {
  lines: GroceryLine[];
  byAisle: Record<string, GroceryLine[]>;
  /** Items used by exactly one recipe. A high count means the list could be shortened by swapping a meal. */
  singleUseItems: number;
}

/**
 * Ingredient grams for one cooking of a recipe, scaled to `servings`, expanded through components.
 * With a `resolve` function, a part marked "have" is skipped and a part marked "buy" becomes its `alt_ingredient` at the
 * same grams. A part with no `alt_ingredient` cannot be bought, so "buy" falls back to making it.
 */
export function expandRecipe(
  slug: string,
  servings: number,
  recipes: ReadonlyMap<string, GroceryRecipe>,
  stack: readonly string[] = [],
  resolve?: PartResolver,
): Map<string, number> {
  if (stack.includes(slug)) throw new UnknownReferenceError(`cycle at ${slug}`);
  const recipe = recipes.get(slug);
  if (!recipe) throw new UnknownReferenceError(`unknown recipe ${slug}`);
  const factor = servings / recipe.servings;
  const out = new Map<string, number>();
  const add = (k: string, g: number) => out.set(k, (out.get(k) ?? 0) + g);
  for (const item of recipe.items) {
    if ("ingredient" in item) {
      add(item.ingredient, item.grams * factor);
    } else {
      const sub = recipes.get(item.component);
      if (!sub) throw new UnknownReferenceError(`unknown component ${item.component}`);
      const mode = resolve?.(item.component);
      if (mode === "have") continue;
      if (mode === "buy" && item.alt_ingredient) {
        add(item.alt_ingredient, item.grams * factor);
        continue;
      }
      const yieldGrams = sub.items.reduce((s, i) => s + i.grams, 0);
      // item.grams of the component is cooked, so the component is made at that fraction of its own yield.
      const subServings = (item.grams * factor * sub.servings) / yieldGrams;
      for (const [k, g] of expandRecipe(item.component, subServings, recipes, [...stack, slug], resolve)) add(k, g);
    }
  }
  return out;
}

/** Tap water goes into recipes in grams so batch weights are right, but nobody shops for it. */
export const FREE_INGREDIENTS: ReadonlySet<string> = new Set(["water-tap"]);

export function roundUpPurchase(grams: number, packSizeG: number | null): { buyGrams: number; packs: number | null } {
  if (packSizeG && packSizeG > 0) {
    const packs = Math.ceil(grams / packSizeG - 1e-9);
    return { buyGrams: packs * packSizeG, packs };
  }
  return { buyGrams: Math.ceil(grams / 10 - 1e-9) * 10, packs: null };
}

export function buildGroceryList(
  meals: readonly PlanMealRef[],
  recipes: ReadonlyMap<string, GroceryRecipe>,
  ingredients: ReadonlyMap<string, GroceryIngredient>,
  /** The plan's part modes. A part marked "have" is left off the list; "buy" swaps in the ready-made ingredient. */
  partModes?: PartModes,
  /** The plan's routines (methi water, soaked almonds) as meal references: servings across all scheduled days and people. */
  routines: readonly PlanMealRef[] = [],
): GroceryList {
  const resolve = resolverFor(partModes);
  const totals = new Map<string, number>();
  const usedBy = new Map<string, Set<string>>();
  for (const meal of [...meals, ...routines]) {
    if (meal.servings <= 0) continue;
    for (const [slug, g] of expandRecipe(meal.recipeSlug, meal.servings, recipes, [], resolve)) {
      if (FREE_INGREDIENTS.has(slug)) continue;
      totals.set(slug, (totals.get(slug) ?? 0) + g);
      const set = usedBy.get(slug) ?? new Set<string>();
      set.add(meal.recipeSlug);
      usedBy.set(slug, set);
    }
  }
  const lines: GroceryLine[] = [];
  for (const [slug, grams] of totals) {
    const ing = ingredients.get(slug);
    if (!ing) throw new UnknownReferenceError(`unknown ingredient ${slug}`);
    const { buyGrams, packs } = roundUpPurchase(grams, ing.pack_size_g);
    lines.push({
      ingredient: slug,
      name: displayName(ing),
      aisle: ing.aisle,
      state: ing.state,
      grams,
      buyGrams,
      packs,
      isPantryStaple: ing.is_pantry_staple,
      recipes: [...(usedBy.get(slug) ?? [])].sort(),
    });
  }
  lines.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
  const byAisle: Record<string, GroceryLine[]> = {};
  for (const l of lines) (byAisle[l.aisle] ??= []).push(l);
  return { lines, byAisle, singleUseItems: lines.filter((l) => !l.isPantryStaple && l.recipes.length === 1).length };
}
