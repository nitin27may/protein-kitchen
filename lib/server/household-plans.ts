import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { refreshHouseholdAccess, requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";
import { HouseholdAccessError } from "../auth/household";
import { persistIngredientPreferences, persistNewPlan, persistPlanDeletion, persistRegeneratedPlan } from "./plan-persistence";
import type { PlannedSlot } from "../planner/types";
import { PersonInput, personRow, type PersonInputData } from "../schemas/person";
import { deletePersonalFeedbackForPerson } from "../human/personal-feedback";

async function lockHouseholdPeople(tx: Tx, access: HouseholdAccess, ids: readonly number[]) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new HouseholdAccessError("Choose distinct profiles from this household.");
  }
  const people = await tx.select({ id: s.people.id }).from(s.people)
    .where(and(inArray(s.people.id, ids), eq(s.people.householdId, access.householdId))).for("update");
  if (people.length !== ids.length) throw new HouseholdAccessError("A selected profile is not in this household.");
}

function checkPortions(ids: readonly number[], slots: readonly Pick<PlannedSlot, "servings">[], routines: readonly { personId: number }[]) {
  if (slots.some((slot) => Object.keys(slot.servings).some((id) => !/^[1-9]\d*$/.test(id) || !ids.includes(Number(id)))) ||
      routines.some((routine) => !ids.includes(routine.personId))) {
    throw new HouseholdAccessError("Plan portions and routines must belong to its selected household profiles.");
  }
}

async function checkStoredPortions(tx: Tx, planId: number, ids: readonly number[]) {
  const portions = await tx.select({ personId: s.planSlotPortions.personId }).from(s.planSlotPortions)
    .innerJoin(s.planSlots, eq(s.planSlots.id, s.planSlotPortions.planSlotId)).where(eq(s.planSlots.planId, planId));
  const routines = await tx.select({ personId: s.planRoutines.personId }).from(s.planRoutines).where(eq(s.planRoutines.planId, planId));
  checkPortions(ids, [], [...portions, ...routines]);
}

async function lockHouseholdPlan(tx: Tx, access: HouseholdAccess, planId: number) {
  await refreshHouseholdAccess(tx, access);
  requireHouseholdProfile(access);
  const [row] = await tx.select({ plan: s.plans, setup: s.planSetups }).from(s.plans)
    .innerJoin(s.planSetups, and(eq(s.planSetups.id, s.plans.setupId), eq(s.planSetups.householdId, access.householdId)))
    .where(and(eq(s.plans.id, planId), eq(s.plans.householdId, access.householdId))).limit(1)
    .for("update", { of: [s.plans, s.planSetups] });
  if (!row) throw new HouseholdAccessError("This plan is not available in your household.");
  return row;
}

export async function householdPeople(db: Db, access: HouseholdAccess) {
  await refreshHouseholdAccess(db, access);
  requireHouseholdProfile(access);
  return db.select().from(s.people).where(eq(s.people.householdId, access.householdId)).orderBy(s.people.id);
}

export async function householdPerson(db: Db, access: HouseholdAccess, personId: number) {
  await refreshHouseholdAccess(db, access);
  requireHouseholdProfile(access);
  const [person] = await db.select().from(s.people).where(and(
    eq(s.people.id, personId), eq(s.people.householdId, access.householdId),
  )).limit(1);
  return person;
}

export async function householdPlans(db: Db, access: HouseholdAccess, limit = 10) {
  await refreshHouseholdAccess(db, access);
  requireHouseholdProfile(access);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Plan limit must be between 1 and 500.");
  return db.select({ id: s.plans.id, startDate: s.planSetups.startDate, endDate: s.planSetups.endDate, createdAt: s.plans.createdAt })
    .from(s.plans).innerJoin(s.planSetups, and(
      eq(s.planSetups.id, s.plans.setupId), eq(s.planSetups.householdId, access.householdId),
    )).where(eq(s.plans.householdId, access.householdId)).orderBy(desc(s.plans.id)).limit(limit);
}

export async function householdPlan(db: Db, access: HouseholdAccess, planId: number) {
  await refreshHouseholdAccess(db, access);
  requireHouseholdProfile(access);
  const [row] = await db.select({ plan: s.plans, setup: s.planSetups }).from(s.plans)
    .innerJoin(s.planSetups, and(eq(s.planSetups.id, s.plans.setupId), eq(s.planSetups.householdId, access.householdId)))
    .where(and(eq(s.plans.id, planId), eq(s.plans.householdId, access.householdId))).limit(1);
  return row;
}

/** Validates every profile reference before the existing atomic plan writer can touch setup/slots/preferences. */
export async function persistHouseholdPlan(db: Db, access: HouseholdAccess, input: Parameters<typeof persistNewPlan>[1]) {
  return withTx(db, async (tx) => {
    await refreshHouseholdAccess(tx, access);
    requireHouseholdProfile(access);
    await lockHouseholdPeople(tx, access, input.setup.personIds);
    checkPortions(input.setup.personIds, input.slots, input.routines);
    return persistNewPlan(tx, { ...input, setup: { ...input.setup, householdId: access.householdId } });
  });
}

export async function regenerateHouseholdPlan(
  db: Db, access: HouseholdAccess, planId: number, seed: number, slots: readonly PlannedSlot[], recipeIds: ReadonlyMap<string, number>,
) {
  await withTx(db, async (tx) => {
    const { setup } = await lockHouseholdPlan(tx, access, planId);
    await lockHouseholdPeople(tx, access, setup.personIds);
    await checkStoredPortions(tx, planId, setup.personIds);
    checkPortions(setup.personIds, slots, []);
    await persistRegeneratedPlan(tx, planId, seed, slots, recipeIds);
  });
}

export async function deleteHouseholdPlan(db: Db, access: HouseholdAccess, planId: number) {
  await withTx(db, async (tx) => {
    await lockHouseholdPlan(tx, access, planId);
    await persistPlanDeletion(tx, planId);
  });
}

export async function mutateHouseholdPlan<T>(
  db: Db, access: HouseholdAccess, planId: number, write: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTx(db, async (tx) => {
    const { setup } = await lockHouseholdPlan(tx, access, planId);
    await lockHouseholdPeople(tx, access, setup.personIds);
    await checkStoredPortions(tx, planId, setup.personIds);
    return write(tx);
  });
}

export async function saveHouseholdPreferences(
  db: Db, access: HouseholdAccess, personId: number, choices: Parameters<typeof persistIngredientPreferences>[2],
) {
  await withTx(db, async (tx) => {
    await refreshHouseholdAccess(tx, access);
    requireHouseholdProfile(access);
    if (access.role !== "owner" && access.personId !== personId) {
      throw new HouseholdAccessError("You can only change your own ingredient preferences.");
    }
    await lockHouseholdPeople(tx, access, [personId]);
    await persistIngredientPreferences(tx, personId, choices);
  });
}

export async function saveHouseholdPerson(db: Db, access: HouseholdAccess, input: PersonInputData) {
  const value = PersonInput.parse(input);
  return withTx(db, async (tx) => {
    await refreshHouseholdAccess(tx, access);
    requireHouseholdProfile(access);
    if (access.role !== "owner" && value.id !== access.personId) {
      throw new HouseholdAccessError("You can only change your own profile.");
    }
    const row = personRow(value);
    if (value.id !== undefined) {
      await lockHouseholdPeople(tx, access, [value.id]);
      await tx.update(s.people).set(row).where(and(eq(s.people.id, value.id), eq(s.people.householdId, access.householdId)));
      return { id: value.id };
    }
    const [created] = await tx.insert(s.people).values({ ...row, householdId: access.householdId }).returning({ id: s.people.id });
    return created!;
  });
}

export async function deleteHouseholdPerson(db: Db, access: HouseholdAccess, personId: number) {
  await withTx(db, async (tx) => {
    await refreshHouseholdAccess(tx, access);
    requireHouseholdProfile(access);
    if (access.role !== "owner") throw new HouseholdAccessError("Only a household owner can delete a profile.");
    await lockHouseholdPeople(tx, access, [personId]);
    const [linked] = await tx.select({ id: s.householdMembers.userId }).from(s.householdMembers)
      .where(eq(s.householdMembers.personId, personId)).limit(1);
    if (linked) throw new HouseholdAccessError("This profile is linked to an account. Manage that account before deleting its profile.");
    const [used] = await tx.select({ id: s.planSlotPortions.planSlotId }).from(s.planSlotPortions)
      .where(eq(s.planSlotPortions.personId, personId)).limit(1);
    if (used) throw new HouseholdAccessError("This profile is part of a saved plan. Delete those plans first.");
    await deletePersonalFeedbackForPerson(tx, personId);
    await tx.delete(s.people).where(and(eq(s.people.id, personId), eq(s.people.householdId, access.householdId)));
  });
}
