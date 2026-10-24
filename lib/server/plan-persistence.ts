import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import type { Tx } from "../db/tx";
import type { PlannedSlot } from "../planner/types";
import { insertPlanSetup } from "./plan-setup";
import type { PlanSetupValues } from "./plan-setup";
import type { PlanRoutineRow } from "./routine-state";

function insertSlots(tx: Tx, planId: number, slots: readonly PlannedSlot[], recipeIds: ReadonlyMap<string, number>): void {
  for (const slot of slots) {
    const recipeId = recipeIds.get(slot.recipeSlug);
    if (recipeId === undefined) throw new Error(`Cannot save plan: recipe "${slot.recipeSlug}" is missing.`);
    const row = tx.insert(s.planSlots).values({
      planId, date: slot.date, slot: slot.slot, recipeId, locked: slot.locked, isLeftover: slot.isLeftover ?? false,
    }).returning({ id: s.planSlots.id }).get();
    for (const [personId, servings] of Object.entries(slot.servings)) {
      tx.insert(s.planSlotPortions).values({ planSlotId: row.id, personId: Number(personId), servings }).run();
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
  return withTx(db, (tx) => {
    const setupId = insertPlanSetup(tx, input.setup);
    const plan = tx.insert(s.plans).values({ setupId, seed: input.seed, createdAt: input.setup.createdAt }).returning({ id: s.plans.id }).get();
    for (const routine of input.routines) tx.insert(s.planRoutines).values({ ...routine, planId: plan.id }).run();
    insertSlots(tx, plan.id, input.slots, input.recipeIds);
    return plan.id;
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
  await withTx(db, (tx) => {
    const plan = tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.id, planId)).get();
    if (!plan) throw new Error("Cannot regenerate plan: plan no longer exists.");
    tx.delete(s.planSlots).where(and(eq(s.planSlots.planId, planId), eq(s.planSlots.locked, false))).run();
    insertSlots(tx, planId, slots.filter((slot) => !slot.locked), recipeIds);
    tx.update(s.plans).set({ seed }).where(eq(s.plans.id, planId)).run();
  });
}

export async function persistPlanDeletion(db: Db, planId: number): Promise<void> {
  await withTx(db, (tx) => {
    const plan = tx.select({ setupId: s.plans.setupId }).from(s.plans).where(eq(s.plans.id, planId)).get();
    if (!plan) return;
    tx.delete(s.plans).where(eq(s.plans.id, planId)).run();
    tx.delete(s.planSetups).where(eq(s.planSetups.id, plan.setupId)).run();
  });
}

export async function persistIngredientPreferences(
  db: Db,
  personId: number,
  choices: readonly { ingredientId: number; kind: "like" | "avoid" }[],
): Promise<void> {
  await withTx(db, (tx) => {
    tx.delete(s.preferences).where(and(eq(s.preferences.personId, personId), inArray(s.preferences.kind, ["like", "avoid"]))).run();
    for (const choice of choices) tx.insert(s.preferences).values({ ...choice, personId }).run();
  });
}
