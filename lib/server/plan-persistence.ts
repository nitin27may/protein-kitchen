import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import type { Tx } from "../db/tx";
import type { PlannedSlot } from "../planner/types";
import { insertPlanSetup } from "./plan-setup";
import type { PlanSetupValues } from "./plan-setup";
import type { PlanRoutineRow } from "./routine-state";

async function insertSlots(tx: Tx, planId: number, slots: readonly PlannedSlot[], recipeIds: ReadonlyMap<string, number>): Promise<void> {
  for (const slot of slots) {
    const recipeId = recipeIds.get(slot.recipeSlug);
    if (recipeId === undefined) throw new Error(`Cannot save plan: recipe "${slot.recipeSlug}" is missing.`);
    const row = (await tx.insert(s.planSlots).values({
      planId, date: slot.date, slot: slot.slot, recipeId, locked: slot.locked, isLeftover: slot.isLeftover ?? false,
    }).returning({ id: s.planSlots.id }))[0];
    for (const [personId, servings] of Object.entries(slot.servings)) {
      await tx.insert(s.planSlotPortions).values({ planSlotId: row!.id, personId: Number(personId), servings });
    }
  }
}

/** Setup, routine snapshot, meals and portions either all persist or all roll back. */
export async function persistNewPlan(
  db: Db,
  input: {
    setup: PlanSetupValues;
    seed: number;
    slots: readonly PlannedSlot[];
    routines: readonly PlanRoutineRow[];
    recipeIds: ReadonlyMap<string, number>;
  },
): Promise<number> {
  return withTx(db, async (tx) => {
    const setupId = await insertPlanSetup(tx, input.setup);
    const plan = (await tx.insert(s.plans).values({ setupId, seed: input.seed, createdAt: input.setup.createdAt }).returning({ id: s.plans.id }))[0];
    for (const routine of input.routines) await tx.insert(s.planRoutines).values({ ...routine, planId: plan!.id });
    await insertSlots(tx, plan!.id, input.slots, input.recipeIds);
    return plan!.id;
  });
}

/** A failed replacement leaves the original meals, portions, locks and seed untouched. */
export async function persistRegeneratedPlan(
  db: Db,
  planId: number,
  seed: number,
  slots: readonly PlannedSlot[],
  recipeIds: ReadonlyMap<string, number>,
): Promise<void> {
  await withTx(db, async (tx) => {
    const plan = (await tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.id, planId)).for("update"))[0];
    if (!plan) throw new Error("Cannot regenerate plan: plan no longer exists.");
    await tx.delete(s.planSlots).where(and(eq(s.planSlots.planId, planId), eq(s.planSlots.locked, false)));
    await insertSlots(tx, planId, slots.filter((slot) => !slot.locked), recipeIds);
    await tx.update(s.plans).set({ seed }).where(eq(s.plans.id, planId));
  });
}

export async function persistPlanDeletion(db: Db, planId: number): Promise<void> {
  await withTx(db, async (tx) => {
    const plan = (await tx.select({ setupId: s.plans.setupId }).from(s.plans).where(eq(s.plans.id, planId)).for("update"))[0];
    if (!plan) return;
    await tx.delete(s.plans).where(eq(s.plans.id, planId));
    await tx.delete(s.planSetups).where(eq(s.planSetups.id, plan.setupId));
  });
}

export async function persistIngredientPreferences(
  db: Db,
  personId: number,
  choices: readonly { ingredientId: number; kind: "like" | "avoid" }[],
): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.select({ id: s.people.id }).from(s.people).where(eq(s.people.id, personId)).for("update");
    await tx.delete(s.preferences).where(and(eq(s.preferences.personId, personId), inArray(s.preferences.kind, ["like", "avoid"])));
    for (const choice of choices) await tx.insert(s.preferences).values({ ...choice, personId });
  });
}
