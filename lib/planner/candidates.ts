import type { DataSet } from "../data/load";
import { effectiveActiveMin, makeAheadMin } from "../data/rules";
import { anchorIngredients, perServing, proteinByIngredient } from "../nutrition/macros";
import type { RecipeTotals } from "../nutrition/macros";
import { isLight, isLowSugar, nutrientDenseSet, qualityPerServing } from "../nutrition/quality";
import type { Candidate } from "./types";

export interface Feedback {
  favourite: boolean;
  banned: boolean;
  rating: number | null;
  tested: boolean;
}

/** All ingredient slugs a recipe uses, expanded through components. */
export function ingredientsOf(slug: string, data: DataSet): Set<string> {
  return new Set(proteinByIngredient(slug, data.recipes, data.ingredients).keys());
}

export function buildCandidates(data: DataSet, feedback: ReadonlyMap<string, Feedback> = new Map()): Candidate[] {
  const memo = new Map<string, RecipeTotals>();
  const out: Candidate[] = [];
  const quality = new Map<string, ReturnType<typeof qualityPerServing>>();
  for (const r of data.recipes.values()) {
    if (r.kind !== "recipe") continue;
    quality.set(r.slug, qualityPerServing(r.slug, perServing(r.slug, data.recipes, data.ingredients, memo), data.recipes, data.ingredients, data.micros));
  }
  const dense = nutrientDenseSet(new Map([...quality].map(([k, v]) => [k, v.score])));
  for (const r of data.recipes.values()) {
    if (r.kind !== "recipe") continue;
    const fb = feedback.get(r.slug);
    const q = quality.get(r.slug)!;
    out.push({
      slug: r.slug,
      name: r.name,
      family: r.family,
      mealSlots: r.meal_slots,
      isIndian: r.is_indian,
      // Hands-on time on the day: parts that must be made fresh count, make-ahead parts do not.
      activeMin: effectiveActiveMin(r, data.recipes),
      makeAheadMin: makeAheadMin(r, data.recipes),
      perServing: perServing(r.slug, data.recipes, data.ingredients, memo),
      anchors: anchorIngredients(r.slug, data.recipes, data.ingredients),
      ingredients: ingredientsOf(r.slug, data),
      lowSugar: isLowSugar(q),
      light: isLight(q, r.meal_slots[0] ?? "dinner"),
      nutrientDense: dense.has(r.slug),
      freeSugarG: q.freeSugarG,
      nutrientScore: q.score,
      batchFriendly: r.fridge_days >= 3,
      fridgeDays: r.fridge_days,
      favourite: fb?.favourite ?? false,
      banned: fb?.banned ?? false,
      rating: fb?.rating ?? null,
      tested: fb?.tested ?? false,
    });
  }
  return out;
}
