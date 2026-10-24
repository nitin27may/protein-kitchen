import * as s from "../db/schema";
import type { Tx } from "../db/tx";
import { isIsoWeekday } from "../planner/weekdays";

/** Relative imports only, so tests can run this against an in-memory database. */

export interface PlanSetupValues {
  personIds: number[];
  startDate: string;
  endDate: string;
  mealTypes: string[];
  cuisineBalance: number;
  maxActiveMin: number | null;
  healthFocus: { nutrientDense: boolean; lowSugar: boolean; light: boolean };
  prepStyle: "variety" | "leftovers" | "batch";
  /** ISO weekdays 1 to 7. Anything else is stored as none. */
  shoppingDay?: number | null;
  prepDay?: number | null;
  createdAt: string;
}

/** Stores a plan's setup, including the optional shopping and prep weekdays. Runs inside the caller's transaction. */
export function insertPlanSetup(tx: Tx, v: PlanSetupValues): number {
  const row = tx
    .insert(s.planSetups)
    .values({
      personIds: v.personIds,
      startDate: v.startDate,
      endDate: v.endDate,
      mealTypes: v.mealTypes,
      cuisineBalance: v.cuisineBalance,
      maxActiveMin: v.maxActiveMin,
      healthFocus: v.healthFocus,
      prepStyle: v.prepStyle,
      shoppingDay: isIsoWeekday(v.shoppingDay) ? v.shoppingDay : null,
      prepDay: isIsoWeekday(v.prepDay) ? v.prepDay : null,
      createdAt: v.createdAt,
    })
    .returning({ id: s.planSetups.id })
    .get();
  return row.id;
}
