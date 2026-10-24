import type { DataSet } from "../data/load";
import { FREE_INGREDIENTS } from "../grocery/aggregate";
import { displayName } from "../schemas";
import type { IsoWeekday, RoutineOption } from "./types";

/**
 * The routines a person can choose, built from data/habits.json (the `routine` block, the evidence grade and the caution)
 * and the routine recipe it points at (the items and the soak). Pure, so the screens and the tests share one answer.
 * A habit whose routine recipe is missing is left out; `pnpm validate` reports that as an error.
 */
export function getRoutineCatalog(data: Pick<DataSet, "habits" | "recipes" | "ingredients">): RoutineOption[] {
  const out: RoutineOption[] = [];
  for (const h of data.habits) {
    if (!h.routine) continue;
    const recipe = data.recipes.get(h.routine.recipe);
    if (!recipe || recipe.kind !== "routine") continue;
    const soaks = recipe.advance_prep.filter((p) => p.kind === "soak").map((p) => p.lead_hours);
    out.push({
      habitSlug: h.slug,
      title: h.title,
      recipeSlug: recipe.slug,
      timeOfDay: h.routine.time_of_day,
      defaultDays: [...h.routine.default_days].sort((a, b) => a - b) as IsoWeekday[],
      grade: h.evidence_grade,
      evidenceNote: h.evidence_note,
      caution: h.caution,
      sourceUrl: h.source_url,
      soakHours: soaks.length ? Math.max(...soaks) : null,
      items: recipe.items.flatMap((i) => {
        if (!("ingredient" in i) || FREE_INGREDIENTS.has(i.ingredient)) return [];
        const ing = data.ingredients.get(i.ingredient);
        return [{ slug: i.ingredient, name: ing ? displayName(ing) : i.ingredient, grams: i.grams }];
      }),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export const catalogByHabit = (catalog: readonly RoutineOption[]): Map<string, RoutineOption> => new Map(catalog.map((o) => [o.habitSlug, o]));
