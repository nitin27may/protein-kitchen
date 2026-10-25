import type { Db } from "../db/client";
import { requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";
import { planMatchesDraft, type AnonDraft } from "../plan/anon-draft";
import { datesBetween } from "../planner/dates";
import { generatePlan } from "../planner/generate";
import type { Candidate, PersonTarget, Slot } from "../planner/types";
import { PlanSetupSchema } from "../schemas";
import { persistHouseholdPlan } from "./household-plans";
import { planRoutineRowsFor } from "./routine-state";

export type ImportDraftResult =
  | { ok: true; planId: number; changed: boolean; libraryChanged: boolean; gaps: number }
  | { ok: false; error: string };

/**
 * Rebuilds the plan on the server from the draft's seed and setup only. The draft's slots and portions are never saved;
 * they are compared with the server's result so the caller can say the plan changed. The caller supplies the
 * household's own candidates and target, so server-side feedback and profile apply.
 */
export async function importDraftPlan(args: {
  db: Db;
  access: HouseholdAccess;
  draft: AnonDraft;
  candidates: readonly Candidate[];
  target: PersonTarget;
  recipeIds: ReadonlyMap<string, number>;
  libraryVersion: string;
  now: Date;
}): Promise<ImportDraftResult> {
  const { draft, access, target } = args;
  const v = draft.setup;
  const personId = requireHouseholdProfile(access);
  const check = PlanSetupSchema.safeParse({
    person_ids: [String(personId)], start_date: v.startDate, end_date: v.endDate, meal_types: v.mealTypes,
    cuisine_balance: v.cuisineBalance, max_active_min: v.maxActiveMin ?? undefined, pinned_recipes: v.pinned,
    shopping_day: v.shoppingDay ?? null, prep_day: v.prepDay ?? null,
  });
  if (!check.success) return { ok: false, error: check.error.issues[0]?.message ?? "Check the dates" };

  const plan = generatePlan({
    dates: datesBetween(v.startDate, v.endDate), mealTypes: v.mealTypes as Slot[], people: [target],
    cuisineBalance: v.cuisineBalance, maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle,
    pinnedRecipes: v.pinned, locked: [], seed: draft.seed,
  }, args.candidates);
  if (plan.slots.length === 0) return { ok: false, error: "No recipes match these choices. Remove an avoided ingredient or relax the time limit." };

  const libraryChanged = draft.libraryVersion !== args.libraryVersion;
  const changed = !planMatchesDraft(draft, plan.slots, target.id);
  const routines = await planRoutineRowsFor(args.db, [personId], v.startDate, v.endDate, 0);
  const planId = await persistHouseholdPlan(args.db, access, {
    setup: {
      personIds: [personId], startDate: v.startDate, endDate: v.endDate, mealTypes: v.mealTypes, cuisineBalance: v.cuisineBalance,
      maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle,
      shoppingDay: v.shoppingDay ?? null, prepDay: v.prepDay ?? null, createdAt: args.now.toISOString(),
    },
    seed: draft.seed, slots: plan.slots, routines, recipeIds: args.recipeIds,
  });
  return { ok: true, planId, changed, libraryChanged, gaps: plan.warnings.filter((w) => w.type === "protein_gap").length };
}
