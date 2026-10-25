import { and, desc, eq, gt, inArray, like } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { DataSet } from "../data/load";
import { buildNight } from "../prep/night";
import { effectivePrepDay } from "../prep/session";
import { datesBetween } from "../planner/dates";
import { isIsoWeekday } from "../planner/weekdays";
import { catalogByHabit, getRoutineCatalog } from "../routines/catalog";
import { routineInputs } from "../routines/schedule";
import { readPartModes } from "../server/part-state";
import { readPlanRoutines } from "../server/routine-state";

/** System traversal only: identities remain private and no request-selected household grants access. */
export async function reminderPeople(db: Db, now: Date) {
  return db.selectDistinct({ person: s.people }).from(s.people)
    .innerJoin(s.householdMembers, and(
      eq(s.householdMembers.personId, s.people.id), eq(s.householdMembers.householdId, s.people.householdId),
    ))
    .innerJoin(s.households, eq(s.households.id, s.people.householdId))
    .innerJoin(s.authUsers, and(eq(s.authUsers.id, s.householdMembers.userId), eq(s.authUsers.emailVerified, true)))
    .innerJoin(s.authSessions, and(eq(s.authSessions.userId, s.authUsers.id), gt(s.authSessions.expiresAt, now)));
}

/** Read-only household projection: no global planner feedback or request-time tick migration. */
export async function householdReminderTasks(db: Db, data: DataSet, householdId: string, date: string): Promise<string[]> {
  return db.transaction((tx) => readHouseholdTasks(tx, data, householdId, date), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}

async function readHouseholdTasks(db: Db, data: DataSet, householdId: string, date: string): Promise<string[]> {
  const [row] = await db.select({ plan: s.plans, setup: s.planSetups }).from(s.plans)
    .leftJoin(s.planSetups, and(eq(s.planSetups.id, s.plans.setupId), eq(s.planSetups.householdId, householdId)))
    .where(eq(s.plans.householdId, householdId)).orderBy(desc(s.plans.id)).limit(1);
  if (!row) return [];
  if (!row.setup) throw new Error("Reminder plan setup is outside its household.");
  const ids = row.setup.personIds;
  const profiles = ids.length ? await db.select({ id: s.people.id }).from(s.people)
    .where(and(inArray(s.people.id, ids), eq(s.people.householdId, householdId))) : [];
  if (!ids.length || new Set(ids).size !== ids.length || profiles.length !== ids.length) {
    throw new Error("Reminder plan contains profiles outside its household.");
  }
  const slots = await db.select({ slot: s.planSlots, slug: s.recipes.slug }).from(s.planSlots)
    .innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId)).where(eq(s.planSlots.planId, row.plan.id));
  const portions = await db.select({ personId: s.planSlotPortions.personId, slotId: s.planSlotPortions.planSlotId, servings: s.planSlotPortions.servings })
    .from(s.planSlotPortions).innerJoin(s.planSlots, eq(s.planSlots.id, s.planSlotPortions.planSlotId))
    .where(eq(s.planSlots.planId, row.plan.id));
  const routines = await readPlanRoutines(db, row.plan.id);
  if ([...portions, ...routines].some((entry) => !ids.includes(entry.personId))) {
    throw new Error("Reminder portions or routines are outside the selected household profiles.");
  }
  const { tasks } = buildNight({
    planId: row.plan.id, earliest: date, recipes: data.recipes,
    meals: slots.map(({ slot, slug }) => ({
      date: slot.date, slot: slot.slot, recipeSlug: slug, leftover: slot.isLeftover,
      servings: portions.filter((portion) => portion.slotId === slot.id).reduce((sum, portion) => sum + portion.servings, 0),
    })),
    partModes: await readPartModes(db, row.plan.id),
    prepDay: effectivePrepDay(isIsoWeekday(row.setup.prepDay) ? row.setup.prepDay : null, row.setup.prepStyle),
    routines: routineInputs(routines, datesBetween(row.setup.startDate, row.setup.endDate), catalogByHabit(getRoutineCatalog(data))),
  });
  const ticks = await db.select({ key: s.prepTaskState.taskKey }).from(s.prepTaskState).where(and(
    eq(s.prepTaskState.householdId, householdId), eq(s.prepTaskState.date, date),
    like(s.prepTaskState.taskKey, `night:${row.plan.id}:%`), eq(s.prepTaskState.done, true),
  ));
  const done = new Set(ticks.map((tick) => tick.key));
  return tasks.filter((task) => task.dueDate === date && !done.has(task.key)).map((task) => `${task.text}, for ${task.forName}`);
}
