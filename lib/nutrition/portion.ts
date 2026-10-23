import type { Ingredient, Recipe, ServingUnit } from "@/lib/schemas";
import { UnknownReferenceError } from "./macros";

type RecipeIndex = ReadonlyMap<string, Recipe>;
type IngredientIndex = ReadonlyMap<string, Ingredient>;

/**
 * Approximate plate weight of one serving, in grams. Dry ingredients count at their cooked weight
 * (cooked_yield), so a dal serving reads as the bowl you eat, not the bag you pour.
 * Water added during cooking and dressing absorbed by food are not counted.
 */
export function servingWeightG(slug: string, recipes: RecipeIndex, ingredients: IngredientIndex, stack: readonly string[] = []): number {
  if (stack.includes(slug)) throw new UnknownReferenceError(`cycle at ${slug}`);
  const recipe = recipes.get(slug);
  if (!recipe) throw new UnknownReferenceError(`unknown recipe ${slug}`);
  let total = 0;
  for (const item of recipe.items) {
    if ("ingredient" in item) {
      const ing = ingredients.get(item.ingredient);
      if (!ing) throw new UnknownReferenceError(`${slug}: unknown ingredient ${item.ingredient}`);
      total += ing.state === "dry" && ing.cooked_yield ? item.grams * ing.cooked_yield : item.grams;
    } else {
      total += item.grams;
    }
  }
  return total / recipe.servings;
}

const FRACTIONS: [number, string][] = [[0.25, "¼"], [0.5, "½"], [0.75, "¾"]];

/** 1.5 -> "1½", 0.25 -> "¼", 2.1 -> "2". Rounds to the nearest quarter. */
export function quarterLabel(n: number): string {
  const q = Math.round(n * 4) / 4;
  const whole = Math.floor(q);
  const frac = FRACTIONS.find(([v]) => v === q - whole)?.[1] ?? "";
  if (!frac) return String(whole);
  return whole === 0 ? frac : `${whole}${frac}`;
}

export interface PortionText {
  /** Primary line, for example "2 rotis" or "about 310 g". */
  amount: string;
  /** Secondary line, for example "1 serving, about 120 g". */
  detail: string;
}

/**
 * Turns a serving count into something you can measure. Countable recipes read as pieces,
 * everything else as grams. `servings` is the number of recipe servings eaten.
 */
export function portionText(servings: number, servingG: number, unit?: ServingUnit | null): PortionText {
  const g = Math.round((servings * servingG) / 5) * 5;
  const servingsText = `${quarterLabel(servings)} ${servings === 1 ? "serving" : "servings"}`;
  if (unit) {
    const count = servings * unit.per_serving;
    const label = count <= 1.01 ? unit.singular : unit.plural;
    return { amount: `${quarterLabel(count)} ${label}`, detail: `${servingsText}, about ${g} g` };
  }
  return { amount: `about ${g} g`, detail: servingsText };
}
