import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { groceryManual, plans, planSlots, planSlotPortions } from "../db/schema";

const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

export async function planExists(db: Db, id: number) {
  if (!validId(id)) return false;
  return (await db.select({ id: plans.id }).from(plans).where(eq(plans.id, id)).limit(1)).length === 1;
}

export async function slotBelongsToPlan(db: Db, planId: number, slotId: number, personId?: number) {
  if (!validId(planId) || !validId(slotId) || (personId !== undefined && !validId(personId))) return false;
  const [slot] = await db.select({ id: planSlots.id }).from(planSlots)
    .where(and(eq(planSlots.id, slotId), eq(planSlots.planId, planId))).limit(1);
  if (!slot) return false;
  if (personId === undefined) return true;
  return (await db.select({ id: planSlotPortions.personId }).from(planSlotPortions)
    .where(and(eq(planSlotPortions.planSlotId, slotId), eq(planSlotPortions.personId, personId))).limit(1)).length === 1;
}

export async function manualItemExists(db: Db, id: number) {
  if (!validId(id)) return false;
  return (await db.select({ id: groceryManual.id }).from(groceryManual)
    .innerJoin(plans, eq(plans.id, groceryManual.planId)).where(eq(groceryManual.id, id)).limit(1)).length === 1;
}
