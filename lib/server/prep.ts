import { and, eq, like, or } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { buildNight, migrateTickKey } from "@/lib/prep/night";
import type { NightTask } from "@/lib/prep/night";
import type { PrepGuide } from "@/lib/prep/session";
import { getData, getDb } from "./context";
import type { PlanView } from "./queries";

export interface NightTaskView extends NightTask {
  done: boolean;
}

export interface NightView {
  guide: PrepGuide;
  tasks: NightTaskView[];
}

/** Total servings cooked for each planned meal, across everyone eating it. */
export function mealsOf(view: PlanView) {
  return view.slots.map((sl) => ({ date: sl.date, slot: sl.slot, recipeSlug: sl.recipeSlug, servings: Object.values(sl.servings).reduce((a, b) => a + b, 0), leftover: sl.isLeftover ?? false }));
}

/**
 * Rewrites tick rows saved under the two older key formats to the current one. Safe to run on every read: keys already
 * in the new format are left alone, so a second run changes nothing. Ticks that match no current task are deleted.
 */
export function migrateTickKeys(planId: number, tasks: readonly NightTask[]): void {
  const db = getDb();
  const rows = db
    .select()
    .from(s.prepTaskState)
    .where(or(like(s.prepTaskState.taskKey, `night:${planId}:%`), like(s.prepTaskState.taskKey, "____-__-__:%")))
    .all();
  const changes = rows.map((r) => ({ r, m: migrateTickKey(r.taskKey, { planId, tasks }) })).filter((x) => x.m.action !== "keep");
  if (changes.length === 0) return;
  db.transaction((tx) => {
    for (const { r, m } of changes) {
      tx.delete(s.prepTaskState).where(and(eq(s.prepTaskState.date, r.date), eq(s.prepTaskState.taskKey, r.taskKey))).run();
      if (m.action === "rename" && r.done) {
        tx.insert(s.prepTaskState).values({ date: m.date, taskKey: m.key, done: true }).onConflictDoUpdate({ target: [s.prepTaskState.date, s.prepTaskState.taskKey], set: { done: true } }).run();
      }
    }
  });
}

/** Night-before tasks for a plan with their ticks, plus the prep guide they came from. The single entry point for every screen. */
export function loadNight(view: PlanView, earliest: string): NightView {
  const { guide, tasks } = buildNight({ planId: view.id, meals: mealsOf(view), recipes: getData().recipes, earliest });
  migrateTickKeys(view.id, tasks);
  const rows = getDb().select().from(s.prepTaskState).where(like(s.prepTaskState.taskKey, `night:${view.id}:%`)).all();
  const done = new Set(rows.filter((r) => r.done).map((r) => r.taskKey));
  return { guide, tasks: tasks.map((t) => ({ ...t, done: done.has(t.key) })) };
}

/** What to do tonight: the tasks due this evening. */
export const tonight = (night: NightView | undefined, today: string): NightTaskView[] => (night ? night.tasks.filter((t) => t.dueDate === today) : []);
