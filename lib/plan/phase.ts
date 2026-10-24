import { buildGroceryList } from "../grocery/aggregate";
import type { PartModes } from "../parts/mode";
import type { Ingredient, Recipe } from "../schemas";
import { addDays } from "../planner/dates";
import { lastWeekdayOnOrBefore } from "../planner/weekdays";
import type { IsoWeekday } from "../routines/types";

/**
 * Pure logic behind the Today screen: which phase the plan is in, what part of the day it is, which panels go where,
 * and how night-before tasks group. Kept free of the database and the clock so every boundary can be tested.
 */

export type DayPart = "morning" | "day" | "evening";

/** Before 11:00 is morning, from 17:00 is evening. `minutes` is minutes since local midnight. */
export const MORNING_ENDS = 11 * 60;
export const EVENING_STARTS = 17 * 60;

export function dayPart(minutes: number): DayPart {
  return minutes < MORNING_ENDS ? "morning" : minutes >= EVENING_STARTS ? "evening" : "day";
}

export interface GroceryProgress {
  /** Items to buy, not counting pantry staples. */
  total: number;
  left: number;
}

export interface FirstTask {
  text: string;
  forName: string;
  /** The evening it has to be done. */
  dueDate: string;
}

export type PlanPhase =
  | { kind: "no-plan"; reason: "none" | "ended"; endedOn: string | null }
  | { kind: "starts-later"; startDate: string; daysUntilStart: number; grocery: GroceryProgress | null; firstTask: FirstTask | null }
  | { kind: "mid-plan"; startDate: string; endDate: string; dayNumber: number; totalDays: number; daysLeft: number }
  | { kind: "last-two-days"; startDate: string; endDate: string; dayNumber: number; totalDays: number; daysLeft: number };

const DAY_MS = 86_400_000;
/** Whole days from `a` to `b` (negative when b is earlier). Dates are ISO calendar dates, read in UTC. */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export function planPhase(
  today: string,
  plan: { startDate: string; endDate: string } | undefined,
  grocery?: GroceryProgress | null,
  firstTask?: FirstTask | null,
): PlanPhase {
  if (!plan) return { kind: "no-plan", reason: "none", endedOn: null };
  if (today < plan.startDate) return { kind: "starts-later", startDate: plan.startDate, daysUntilStart: daysBetween(today, plan.startDate), grocery: grocery ?? null, firstTask: firstTask ?? null };
  if (today > plan.endDate) return { kind: "no-plan", reason: "ended", endedOn: plan.endDate };
  const daysLeft = daysBetween(today, plan.endDate);
  const base = { startDate: plan.startDate, endDate: plan.endDate, dayNumber: daysBetween(plan.startDate, today) + 1, totalDays: daysBetween(plan.startDate, plan.endDate) + 1, daysLeft };
  return daysLeft <= 1 ? { kind: "last-two-days", ...base } : { kind: "mid-plan", ...base };
}

export type PanelId = "hero" | "meals" | "tonight" | "basics" | "grocery" | "snack" | "links";

/**
 * Which panels go in the main column and which in the side column. On a phone the side column follows the main one,
 * so the order reads: phase card, then Morning or Tonight depending on the time, meals, groceries, basics, snack.
 */
export function layoutFor(kind: PlanPhase["kind"], part: DayPart): { main: PanelId[]; side: PanelId[] } {
  switch (kind) {
    case "no-plan":
      return { main: ["hero"], side: ["basics", "snack"] };
    case "starts-later":
      return { main: ["hero", "grocery", "tonight"], side: ["basics", "snack", "links"] };
    default:
      return part === "morning"
        ? { main: ["hero", "basics", "meals", "tonight"], side: ["grocery", "snack", "links"] }
        : part === "evening"
          ? { main: ["hero", "tonight", "meals"], side: ["grocery", "basics", "snack", "links"] }
          : { main: ["hero", "meals", "tonight"], side: ["grocery", "basics", "snack", "links"] };
  }
}

interface NightLike {
  dueDate: string;
  cookDate: string;
  done: boolean;
}

/**
 * Splits night-before tasks for Today. Tonight is what is due this evening. Overdue is what was due earlier, is not
 * ticked and is still worth doing because the food has not been cooked yet. Upcoming is everything after tonight.
 */
export function groupNightTasks<T extends NightLike>(tasks: readonly T[], today: string): { overdue: T[]; tonight: T[]; upcoming: T[] } {
  const byDue = (a: T, b: T) => a.dueDate.localeCompare(b.dueDate);
  return {
    overdue: tasks.filter((t) => t.dueDate < today && !t.done && t.cookDate >= today).sort(byDue),
    tonight: tasks.filter((t) => t.dueDate === today),
    upcoming: tasks.filter((t) => t.dueDate > today).sort(byDue),
  };
}

/** The earliest task that is not ticked. */
export function firstOpenTask<T extends NightLike>(tasks: readonly T[]): T | undefined {
  return [...tasks].filter((t) => !t.done).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
}

/**
 * The day to finish shopping: the day before the first thing that needs ingredients, which is the first night-before
 * task or the first cooking day. Never earlier than today. With a chosen shopping day, the last such weekday on or
 * before that day (still never earlier than today).
 */
export function shopByDate(today: string, startDate: string, firstTaskDue?: string | null, shoppingDay?: IsoWeekday | null): string {
  const needed = firstTaskDue && firstTaskDue < startDate ? firstTaskDue : startDate;
  const by = addDays(needed, -1);
  const target = shoppingDay ? lastWeekdayOnOrBefore(by, shoppingDay) : by;
  return target < today ? today : target;
}

/**
 * Items left to buy for the whole plan. Uses the same grocery list the Groceries page builds, minus pantry staples,
 * which that page lists separately and does not count.
 */
export function groceryProgressFrom(
  meals: readonly { recipeSlug: string; servings: number }[],
  recipes: ReadonlyMap<string, Recipe>,
  ingredients: ReadonlyMap<string, Ingredient>,
  checked: ReadonlySet<string>,
  partModes?: PartModes,
  routines?: readonly { recipeSlug: string; servings: number }[],
): GroceryProgress {
  const lines = buildGroceryList(meals, recipes, ingredients, partModes, routines).lines.filter((l) => !l.isPantryStaple);
  return { total: lines.length, left: lines.filter((l) => !checked.has(l.ingredient)).length };
}
