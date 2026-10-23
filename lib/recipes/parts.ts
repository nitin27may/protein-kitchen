import { displayName } from "../schemas";
import type { Ingredient, Recipe } from "../schemas";
import { recipeTotals, scale } from "../nutrition/macros";
import type { RecipeTotals } from "../nutrition/macros";
import type { PartView } from "./timeline";

export { buildTimeline, effectiveMode, leadLabel, partsToMake } from "./timeline";
export type { PartAdvance, PartIngredientView, PartStepView, PartView, TimelineLine, TimelineOptions } from "./timeline";

type RecipeIndex = ReadonlyMap<string, Recipe>;
type IngredientIndex = ReadonlyMap<string, Ingredient>;

interface Chain {
  /** Fraction of the part's own yield that this meal uses. */
  share: number;
  /** Servings of the meal being viewed divided by its base servings. */
  factor: number;
  /** Base servings of the meal: contributions are quoted per one serving of it. */
  mealServings: number;
}

function build(recipes: RecipeIndex, ingredients: IngredientIndex, slug: string, item: Extract<Recipe["items"][number], { component: string }>, chain: Chain, memo: Map<string, RecipeTotals>, stack: readonly string[]): PartView | null {
  const sub = recipes.get(slug);
  if (!sub || stack.includes(slug)) return null;
  const totals = recipeTotals(slug, recipes, ingredients, [], memo);
  const contribution = scale(totals.macros, chain.share / chain.mealServings);

  const direct: PartView["ingredients"] = [];
  const children: PartView[] = [];
  for (const it of sub.items) {
    if ("ingredient" in it) {
      const ing = ingredients.get(it.ingredient);
      direct.push({ slug: it.ingredient, name: ing ? displayName(ing) : it.ingredient, state: ing?.state ?? "ready", grams: it.grams * chain.share * chain.factor });
    } else {
      const childTotals = recipeTotals(it.component, recipes, ingredients, [], memo);
      const child = build(recipes, ingredients, it.component, it, { ...chain, share: (it.grams / childTotals.grams) * chain.share }, memo, [...stack, slug]);
      if (child) children.push(child);
    }
  }

  const alt = item.alt_ingredient ? ingredients.get(item.alt_ingredient) : undefined;
  return {
    slug,
    name: sub.name,
    label: item.label ?? null,
    displayQty: item.display_qty ?? null,
    displayUnit: item.display_unit ?? null,
    // share of the part's own yield, times that yield, is the weight of the part in the meal; factor scales it to the servings viewed.
    grams: chain.share * totals.grams * chain.factor,
    fridgeDays: sub.fridge_days,
    keeps: sub.fridge_days >= 2,
    activeMin: sub.active_min,
    totalMin: sub.total_min,
    ingredients: direct,
    steps: sub.steps.map((s) => ({ text: s.text, cue: s.cue ?? null, tip: s.tip ?? null, timerSec: s.timer_sec ?? null })),
    advancePrep: sub.advance_prep.map((a) => ({ leadHours: a.lead_hours, instruction: a.instruction })),
    protein: contribution.protein_g,
    kcal: contribution.kcal,
    fibre: contribution.fibre_g,
    hasAlt: !!alt,
    altSlug: alt ? item.alt_ingredient! : null,
    altName: alt ? displayName(alt) : null,
    children,
  };
}

/**
 * The parts (components) a meal is made of, with each part's scaled ingredients, steps, timing and what it adds to one
 * serving. `servings` is how many servings are being viewed; it scales weights only, never the per-serving numbers.
 * The numbers of the top-level parts, plus the meal's own direct ingredients, add up to the meal's per-serving totals.
 */
export function partsOf(recipe: Recipe, recipes: RecipeIndex, ingredients: IngredientIndex, servings: number): PartView[] {
  const memo = new Map<string, RecipeTotals>();
  const factor = servings / recipe.servings;
  return recipe.items.flatMap((item) => {
    if (!("component" in item)) return [];
    const totals = recipeTotals(item.component, recipes, ingredients, [], memo);
    const view = build(recipes, ingredients, item.component, item, { share: item.grams / totals.grams, factor, mealServings: recipe.servings }, memo, [recipe.slug]);
    return view ? [view] : [];
  });
}

export interface UsedIn {
  slug: string;
  name: string;
  kind: Recipe["kind"];
  /** Grams of the part in one serving of that meal. */
  gramsPerServing: number;
}

/** Meals (and other parts) that use a component directly, for the "Used in" list on a part's page. */
export function usedIn(componentSlug: string, recipes: RecipeIndex): UsedIn[] {
  return [...recipes.values()]
    .flatMap((r) => {
      const grams = r.items.filter((i) => "component" in i && i.component === componentSlug).reduce((s, i) => s + i.grams, 0);
      return grams > 0 ? [{ slug: r.slug, name: r.name, kind: r.kind, gramsPerServing: grams / r.servings }] : [];
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "recipe" ? -1 : 1));
}
