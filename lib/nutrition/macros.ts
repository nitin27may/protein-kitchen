import type { Ingredient, Macros, Recipe } from "../schemas";

export class UnknownReferenceError extends Error {}
export class CycleError extends Error {}

export const ZERO: Macros = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fibre_g: 0 };

export function scale(m: Macros, factor: number): Macros {
  return {
    kcal: m.kcal * factor,
    protein_g: m.protein_g * factor,
    carbs_g: m.carbs_g * factor,
    fat_g: m.fat_g * factor,
    fibre_g: m.fibre_g * factor,
  };
}

export function add(a: Macros, b: Macros): Macros {
  return {
    kcal: a.kcal + b.kcal,
    protein_g: a.protein_g + b.protein_g,
    carbs_g: a.carbs_g + b.carbs_g,
    fat_g: a.fat_g + b.fat_g,
    fibre_g: a.fibre_g + b.fibre_g,
  };
}

/** Macros for `grams` of an ingredient, using its per-100g values in the state it is stored in. */
export function ingredientMacros(ing: Ingredient, grams: number): Macros {
  return scale(ing.per100g, grams / 100);
}

export function dryToCooked(dryGrams: number, cookedYield: number): number {
  return dryGrams * cookedYield;
}

export function cookedToDry(cookedGrams: number, cookedYield: number): number {
  return cookedGrams / cookedYield;
}

/**
 * Atwater estimate with fibre counted at 2 kcal/g. CNF and IFCT carbohydrate figures include fibre,
 * so the plain 4/4/9 rule over-predicts energy for vegetables, spices and legumes.
 */
export function atwaterKcal(m: Macros): number {
  const digestibleCarbs = Math.max(m.carbs_g - m.fibre_g, 0);
  return 4 * m.protein_g + 4 * digestibleCarbs + 2 * m.fibre_g + 9 * m.fat_g;
}

/** Tolerance is 15 percent of the stated kcal or 8 kcal, whichever is larger. */
export function kcalDeviationOk(m: Macros): boolean {
  if (m.kcal <= 0) return m.protein_g + m.carbs_g + m.fat_g <= 1;
  return Math.abs(m.kcal - atwaterKcal(m)) <= Math.max(0.15 * m.kcal, 8);
}

export interface RecipeTotals {
  macros: Macros;
  /** Sum of item weights. For a component this is the yield used to turn totals into per-gram rates. */
  grams: number;
}

export type RecipeIndex = ReadonlyMap<string, Recipe>;
export type IngredientIndex = ReadonlyMap<string, Ingredient>;

export function recipeTotals(
  slug: string,
  recipes: RecipeIndex,
  ingredients: IngredientIndex,
  stack: readonly string[] = [],
  memo: Map<string, RecipeTotals> = new Map(),
): RecipeTotals {
  const cached = memo.get(slug);
  if (cached) return cached;
  if (stack.includes(slug)) throw new CycleError(`component cycle: ${[...stack, slug].join(" -> ")}`);

  const recipe = recipes.get(slug);
  if (!recipe) throw new UnknownReferenceError(`unknown recipe or component "${slug}"`);

  let macros = ZERO;
  let grams = 0;
  for (const item of recipe.items) {
    if ("ingredient" in item) {
      const ing = ingredients.get(item.ingredient);
      if (!ing) throw new UnknownReferenceError(`${slug}: unknown ingredient "${item.ingredient}"`);
      macros = add(macros, ingredientMacros(ing, item.grams));
    } else {
      const sub = recipeTotals(item.component, recipes, ingredients, [...stack, slug], memo);
      if (recipes.get(item.component)?.kind !== "component") {
        throw new UnknownReferenceError(`${slug}: "${item.component}" is not a component`);
      }
      macros = add(macros, scale(sub.macros, item.grams / sub.grams));
    }
    grams += item.grams;
  }

  const result = { macros, grams };
  memo.set(slug, result);
  return result;
}

export function perServing(
  slug: string,
  recipes: RecipeIndex,
  ingredients: IngredientIndex,
  memo?: Map<string, RecipeTotals>,
): Macros {
  const recipe = recipes.get(slug);
  if (!recipe) throw new UnknownReferenceError(`unknown recipe "${slug}"`);
  const { macros } = recipeTotals(slug, recipes, ingredients, [], memo);
  return scale(macros, 1 / recipe.servings);
}

/**
 * Protein grams contributed by each ingredient to the whole recipe, expanded through components.
 * The planner uses the top entries as a recipe's anchor proteins when matching "liked ingredients".
 */
export function proteinByIngredient(
  slug: string,
  recipes: RecipeIndex,
  ingredients: IngredientIndex,
  stack: readonly string[] = [],
  memo: Map<string, RecipeTotals> = new Map(),
): Map<string, number> {
  if (stack.includes(slug)) throw new CycleError(`component cycle: ${[...stack, slug].join(" -> ")}`);
  const recipe = recipes.get(slug);
  if (!recipe) throw new UnknownReferenceError(`unknown recipe or component "${slug}"`);
  const out = new Map<string, number>();
  const bump = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
  for (const item of recipe.items) {
    if ("ingredient" in item) {
      const ing = ingredients.get(item.ingredient);
      if (!ing) throw new UnknownReferenceError(`${slug}: unknown ingredient "${item.ingredient}"`);
      bump(item.ingredient, ingredientMacros(ing, item.grams).protein_g);
    } else {
      const sub = recipeTotals(item.component, recipes, ingredients, [...stack, slug], memo);
      const share = item.grams / sub.grams;
      for (const [k, v] of proteinByIngredient(item.component, recipes, ingredients, [...stack, slug], memo)) bump(k, v * share);
    }
  }
  return out;
}

/** Ingredients that supply at least `minShare` of the recipe's protein, largest first. */
export function anchorIngredients(
  slug: string,
  recipes: RecipeIndex,
  ingredients: IngredientIndex,
  minShare = 0.2,
): string[] {
  const by = proteinByIngredient(slug, recipes, ingredients);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return [...by.entries()]
    .filter(([, v]) => v / total >= minShare)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}
