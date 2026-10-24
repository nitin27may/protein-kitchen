import { perServing } from "../nutrition/macros";
import type { Ingredient, Recipe } from "../schemas";
import type { PlanMealRef } from "../grocery/aggregate";
import type { RoutineInput } from "../prep/night";
import type { IsoWeekday, PlanRoutineView, RoutineOption } from "./types";

/** A routine soaked for fewer hours than this is a morning job, not a night-before task. */
export const ROUTINE_NIGHT_MIN_LEAD_H = 4;

/** ISO weekday of a date: 1 = Monday ... 7 = Sunday. Computed in UTC, like the rest of the date code. */
export function isoWeekday(date: string): IsoWeekday {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (d === 0 ? 7 : d) as IsoWeekday;
}

/** The plan dates a routine falls on: dates whose weekday is one of `days`. */
export const scheduledDates = (planDates: readonly string[], days: readonly number[]): string[] => planDates.filter((d) => days.includes(isoWeekday(d)));

type Choice = Pick<PlanRoutineView, "habitSlug" | "days" | "servings" | "personId">;

/**
 * Grocery references for a plan's routines: one entry per routine recipe with the servings of every scheduled
 * occurrence across all people added together, so groceries scale by scheduled days and people. Choices whose habit is
 * not in the catalog are ignored.
 */
export function routineMealRefs(choices: readonly Choice[], planDates: readonly string[], catalog: ReadonlyMap<string, Pick<RoutineOption, "recipeSlug">>): PlanMealRef[] {
  const total = new Map<string, number>();
  for (const c of choices) {
    const opt = catalog.get(c.habitSlug);
    if (!opt) continue;
    const n = scheduledDates(planDates, c.days).length;
    if (n === 0) continue;
    total.set(opt.recipeSlug, (total.get(opt.recipeSlug) ?? 0) + n * c.servings);
  }
  return [...total].sort(([a], [b]) => (a < b ? -1 : 1)).map(([recipeSlug, servings]) => ({ recipeSlug, servings }));
}

/**
 * Night-before inputs: one per person's choice, with the mornings it falls on. Only routines that need a long enough soak
 * produce a task (see ROUTINE_NIGHT_MIN_LEAD_H); `buildNight` combines people on the same evening.
 */
export function routineInputs(choices: readonly Choice[], planDates: readonly string[], catalog: ReadonlyMap<string, Pick<RoutineOption, "recipeSlug">>): RoutineInput[] {
  const out: RoutineInput[] = [];
  for (const c of choices) {
    const opt = catalog.get(c.habitSlug);
    if (!opt) continue;
    const dates = scheduledDates(planDates, c.days);
    if (dates.length === 0) continue;
    out.push({ habitSlug: c.habitSlug, recipeSlug: opt.recipeSlug, dates, servings: c.servings });
  }
  return out;
}

export interface DayRoutineTotals {
  kcal: number;
  protein_g: number;
  fibre_g: number;
}

/**
 * What the routines add to each person's day: protein, kcal and fibre per person per date, from the routine recipes'
 * ingredient data. Not part of the generator or the day totals yet; a screen may show it as its own line.
 */
export function routineDayTotals(
  choices: readonly Choice[],
  planDates: readonly string[],
  catalog: ReadonlyMap<string, Pick<RoutineOption, "recipeSlug">>,
  recipes: ReadonlyMap<string, Recipe>,
  ingredients: ReadonlyMap<string, Ingredient>,
): Record<string, Record<number, DayRoutineTotals>> {
  const out: Record<string, Record<number, DayRoutineTotals>> = {};
  for (const c of choices) {
    const opt = catalog.get(c.habitSlug);
    if (!opt) continue;
    const m = perServing(opt.recipeSlug, recipes, ingredients);
    for (const date of scheduledDates(planDates, c.days)) {
      const day = (out[date] ??= {});
      const cur = (day[c.personId] ??= { kcal: 0, protein_g: 0, fibre_g: 0 });
      cur.kcal += m.kcal * c.servings;
      cur.protein_g += m.protein_g * c.servings;
      cur.fibre_g += m.fibre_g * c.servings;
    }
  }
  return out;
}
