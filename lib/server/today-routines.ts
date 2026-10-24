import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { routinesForDate } from "../routines/schedule";
import type { TimeOfDay } from "../routines/types";
import { readPersonRoutines } from "./routine-state";

// Relative imports only, so tests can run this against an in-memory database.

export interface TodayRoutine {
  habitSlug: string;
  timeOfDay: TimeOfDay;
  servings: number;
  done: boolean;
}

/**
 * The routines a person has chosen that fall on `date`'s weekday, in time-of-day order, with whether each is ticked in
 * habit_log for that date. Independent of any plan: the plan's snapshot drives groceries and prep, this drives the daily tick.
 */
export async function readTodayRoutines(db: Db, personId: number, date: string): Promise<TodayRoutine[]> {
  const scheduled = routinesForDate(await readPersonRoutines(db, personId), date);
  if (scheduled.length === 0) return [];
  const habits = await db.select({ id: s.habits.id, slug: s.habits.slug }).from(s.habits);
  const idBySlug = new Map(habits.map((h) => [h.slug, h.id]));
  const log = await db.select({ habitId: s.habitLog.habitId, done: s.habitLog.done }).from(s.habitLog).where(and(eq(s.habitLog.date, date), eq(s.habitLog.personId, personId)));
  const doneIds = new Set(log.filter((r) => r.done).map((r) => r.habitId));
  return scheduled.map((r) => ({ habitSlug: r.habitSlug, timeOfDay: r.timeOfDay, servings: r.servings, done: doneIds.has(idBySlug.get(r.habitSlug) ?? -1) }));
}
