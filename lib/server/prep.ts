import { and, eq, like, or } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { withTx } from "@/lib/db/tx";
import { buildNight, migrateTickKey } from "@/lib/prep/night";
import type { NightTask } from "@/lib/prep/night";
import { effectivePrepDay } from "@/lib/prep/session";
import type { PrepGuide } from "@/lib/prep/session";
import { getData, getDb } from "./context";
import { getPartModes, routineContext } from "./queries";
import type { PlanView } from "./queries";
import type { Db } from "../db/client";

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

async function planHousehold(db: Db, planId: number): Promise<string> {
  const [plan] = await db.select({ householdId: s.plans.householdId }).from(s.plans).where(eq(s.plans.id, planId));
  if (!plan?.householdId) throw new Error("Prep tasks require a household-owned plan.");
  return plan.householdId;
}

/**
 * Rewrites tick rows saved under the two older key formats to the current one. Safe to run on every read: keys already
 * in the new format are left alone, so a second run changes nothing. Ticks that match no current task are deleted.
 */
export async function migrateTickKeys(planId: number, tasks: readonly NightTask[]): Promise<void> {
  const db = await getDb();
  const householdId = await planHousehold(db, planId);
  const rows = await db
    .select()
    .from(s.prepTaskState)
    .where(and(eq(s.prepTaskState.householdId, householdId), or(like(s.prepTaskState.taskKey, `night:${planId}:%`), like(s.prepTaskState.taskKey, "____-__-__:%"))));
  const changes = rows.map((r) => ({ r, m: migrateTickKey(r.taskKey, { planId, tasks }) })).filter((x) => x.m.action !== "keep");
  if (changes.length === 0) return;
  await withTx(db, async (tx) => {
    for (const { r, m } of changes) {
      await tx.delete(s.prepTaskState).where(and(eq(s.prepTaskState.householdId, householdId), eq(s.prepTaskState.date, r.date), eq(s.prepTaskState.taskKey, r.taskKey)));
      if (m.action === "rename" && r.done) {
        const saved = await tx.insert(s.prepTaskState).values({ householdId, date: m.date, taskKey: m.key, done: true })
          .onConflictDoUpdate({ target: [s.prepTaskState.date, s.prepTaskState.taskKey], set: { done: true }, setWhere: eq(s.prepTaskState.householdId, householdId) })
          .returning({ key: s.prepTaskState.taskKey });
        if (saved.length === 0) throw new Error("Prep tick ownership conflicts with this household.");
      }
    }
  });
}

/** Night-before tasks for a plan with their ticks, plus the prep guide they came from. The single entry point for every screen. */
export async function loadNight(view: PlanView, earliest: string): Promise<NightView> {
  const db = await getDb();
  const householdId = await planHousehold(db, view.id);
  const { guide, tasks } = buildNight({ planId: view.id, meals: mealsOf(view), recipes: getData().recipes, earliest, partModes: await getPartModes(view.id), prepDay: effectivePrepDay(view.prepDay, view.input.prepStyle), routines: (await routineContext(view)).inputs });
  await migrateTickKeys(view.id, tasks);
  const rows = await db.select().from(s.prepTaskState).where(and(eq(s.prepTaskState.householdId, householdId), like(s.prepTaskState.taskKey, `night:${view.id}:%`)));
  const done = new Set(rows.filter((r) => r.done).map((r) => r.taskKey));
  return { guide, tasks: tasks.map((t) => ({ ...t, done: done.has(t.key) })) };
}

/** What to do tonight: the tasks due this evening. */
export const tonight = (night: NightView | undefined, today: string): NightTaskView[] => (night ? night.tasks.filter((t) => t.dueDate === today) : []);
