import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { writePersonRoutine } from "../human/routines";
import { datesBetween } from "../planner/dates";
import { scheduledDates } from "../routines/schedule";
import { TIMES_OF_DAY } from "../routines/types";
import type { IsoWeekday, PersonRoutineView, PlanRoutineView, RoutineOption, TimeOfDay } from "../routines/types";

// Relative imports only, so tests can run this against an in-memory database.

export type RoutineResult = { ok: true } | { ok: false; error: string };

const asDays = (value: unknown): IsoWeekday[] => (Array.isArray(value) ? (value.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) as IsoWeekday[]) : []);

export async function readPersonRoutines(db: Db, personId: number): Promise<PersonRoutineView[]> {
  const rows = await db
    .select({ r: s.personRoutines, slug: s.habits.slug })
    .from(s.personRoutines)
    .innerJoin(s.habits, eq(s.habits.id, s.personRoutines.habitId))
    .where(eq(s.personRoutines.personId, personId));
  return rows
    .map(({ r, slug }) => ({ habitSlug: slug, active: r.active, days: asDays(r.days), timeOfDay: r.timeOfDay as TimeOfDay, servings: r.servings }))
    .sort((a, b) => (a.habitSlug < b.habitSlug ? -1 : 1));
}

export async function readPlanRoutines(db: Db, planId: number): Promise<PlanRoutineView[]> {
  const rows = await db
    .select({ r: s.planRoutines, slug: s.habits.slug })
    .from(s.planRoutines)
    .innerJoin(s.habits, eq(s.habits.id, s.planRoutines.habitId))
    .where(eq(s.planRoutines.planId, planId));
  return rows
    .map(({ r, slug }) => ({ planId: r.planId, personId: r.personId, habitSlug: slug, days: asDays(r.days), timeOfDay: r.timeOfDay as TimeOfDay, servings: r.servings }))
    .sort((a, b) => a.personId - b.personId || (a.habitSlug < b.habitSlug ? -1 : 1));
}

export interface RoutinePatch {
  active: boolean;
  days?: IsoWeekday[];
  timeOfDay?: TimeOfDay;
  servings?: number;
}

/**
 * Saves a person's choice of a routine after checking it: the person exists, the habit is a routine, the days are unique
 * and within 1 to 7 (and not empty), the time of day is known, and servings are 1 to 4 in half steps. Anything not given
 * falls back to the person's existing choice, then to the routine's defaults from the catalog.
 */
export async function savePersonRoutine(db: Db, catalog: ReadonlyMap<string, RoutineOption>, personId: number, habitSlug: string, patch: RoutinePatch): Promise<RoutineResult> {
  const [person] = await db.select({ id: s.people.id }).from(s.people).where(eq(s.people.id, personId));
  if (!person) return { ok: false, error: "That profile no longer exists" };
  const option = catalog.get(habitSlug);
  if (!option) return { ok: false, error: "That is not a routine you can choose" };
  const [habit] = await db.select({ id: s.habits.id }).from(s.habits).where(eq(s.habits.slug, habitSlug));
  if (!habit) return { ok: false, error: "That routine is not in the library yet. Reload and try again" };

  const [current] = await db.select().from(s.personRoutines).where(and(eq(s.personRoutines.personId, personId), eq(s.personRoutines.habitId, habit.id)));
  const days = patch.days ?? (current ? asDays(current.days) : option.defaultDays);
  const timeOfDay = patch.timeOfDay ?? (current ? (current.timeOfDay as TimeOfDay) : option.timeOfDay);
  const servings = patch.servings ?? current?.servings ?? 1;

  if (days.length === 0) return { ok: false, error: "Choose at least one day" };
  if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(days).size !== days.length) return { ok: false, error: "Days must be Monday to Sunday, each once" };
  if (!(TIMES_OF_DAY as readonly string[]).includes(timeOfDay)) return { ok: false, error: "Choose a time of day from the list" };
  if (!Number.isFinite(servings) || servings < 1 || servings > 4 || Math.round(servings * 2) !== servings * 2) return { ok: false, error: "Servings must be between 1 and 4, in half steps" };

  await writePersonRoutine(db, personId, habit.id, { active: patch.active, days: [...days].sort((a, b) => a - b), timeOfDay, servings });
  return { ok: true };
}

export interface PlanRoutineRow {
  planId: number;
  personId: number;
  habitId: number;
  days: number[];
  timeOfDay: string;
  servings: number;
}

/**
 * The rows to store for a new plan: every active routine choice of the people in the plan, kept only if at least one of its
 * days falls inside the plan's dates. Reads the choices before the plan transaction starts, so the insert itself can run
 * inside it without awaiting anything.
 */
export async function planRoutineRowsFor(db: Db, personIds: readonly number[], startDate: string, endDate: string, planId: number): Promise<PlanRoutineRow[]> {
  if (personIds.length === 0) return [];
  const dates = datesBetween(startDate, endDate);
  const chosen = await db.select().from(s.personRoutines).where(and(inArray(s.personRoutines.personId, [...personIds]), eq(s.personRoutines.active, true)));
  return chosen
    .filter((c) => scheduledDates(dates, asDays(c.days)).length > 0)
    .map((c) => ({ planId, personId: c.personId, habitId: c.habitId, days: asDays(c.days), timeOfDay: c.timeOfDay, servings: c.servings }));
}
