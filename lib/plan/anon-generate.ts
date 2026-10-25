import { datesBetween } from "../planner/dates";
import { computeFeasibility } from "../planner/feasibility";
import type { FeasibilityResult } from "../planner/feasibility-types";
import { generatePlan } from "../planner/generate";
import type { GeneratedPlan, Slot } from "../planner/types";
import { buildGroceryList, type GroceryList, type PlanMealRef } from "../grocery/aggregate";
import { PlanSetupSchema } from "../schemas";
import { anonProfileToTarget, buildAnonDraft, draftToPlannedSlots, portionKey, type AnonDraft, type AnonProfile } from "./anon-draft";
import type { AnonLibrary } from "./anon-library";
import { CreatePlanInput } from "./create-plan-input";
import type { z } from "zod";

/**
 * Runs the existing pure planner on the device. No network, no storage, no clock: the caller supplies the seed and the
 * time. The same seed, setup, profile and library give the same plan here and on the server.
 */

export type AnonSetupInput = z.input<typeof CreatePlanInput>;

export type AnonGenerateResult =
  | { ok: true; draft: AnonDraft; plan: GeneratedPlan; gaps: number }
  | { ok: false; error: string };

function parseSetup(input: AnonSetupInput): { ok: true; setup: z.output<typeof CreatePlanInput> } | { ok: false; error: string } {
  const parsed = CreatePlanInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the plan setup" };
  const v = parsed.data;
  const check = PlanSetupSchema.safeParse({
    person_ids: v.personIds.map(String), start_date: v.startDate, end_date: v.endDate, meal_types: v.mealTypes,
    cuisine_balance: v.cuisineBalance, max_active_min: v.maxActiveMin ?? undefined, pinned_recipes: v.pinned,
    shopping_day: v.shoppingDay ?? null, prep_day: v.prepDay ?? null,
  });
  if (!check.success) return { ok: false, error: check.error.issues[0]?.message ?? "Check the dates" };
  return { ok: true, setup: v };
}

export function planInputFor(setup: z.output<typeof CreatePlanInput>, profile: AnonProfile, seed: number) {
  return {
    dates: datesBetween(setup.startDate, setup.endDate),
    mealTypes: setup.mealTypes as Slot[],
    people: [anonProfileToTarget(profile)],
    cuisineBalance: setup.cuisineBalance,
    maxActiveMin: setup.maxActiveMin,
    healthFocus: setup.healthFocus,
    prepStyle: setup.prepStyle,
    pinnedRecipes: setup.pinned,
    locked: [],
    seed,
  };
}

/** The Review step's check, on the device: how many recipes pass and whether the protein target is reachable. */
export function anonFeasibility(setupInput: AnonSetupInput, profile: AnonProfile, library: AnonLibrary): { ok: true; result: FeasibilityResult } | { ok: false; error: string } {
  const parsed = parseSetup(setupInput);
  if (!parsed.ok) return parsed;
  const target = anonProfileToTarget(profile);
  return { ok: true, result: computeFeasibility({ ...parsed.setup, mealTypes: parsed.setup.mealTypes as Slot[] }, library.candidates, [target]) };
}

export function generateAnonPlan(args: {
  setup: AnonSetupInput;
  profile: AnonProfile;
  library: AnonLibrary;
  seed: number;
  now: Date;
}): AnonGenerateResult {
  const parsed = parseSetup(args.setup);
  if (!parsed.ok) return parsed;
  const plan = generatePlan(planInputFor(parsed.setup, args.profile, args.seed), args.library.candidates);
  if (plan.slots.length === 0) return { ok: false, error: "No recipes match these choices. Remove an avoided ingredient or relax the time limit." };
  const draft = buildAnonDraft({ setup: parsed.setup, seed: args.seed, plan, libraryVersion: args.library.libraryVersion, now: args.now });
  return { ok: true, draft, plan, gaps: plan.warnings.filter((w) => w.type === "protein_gap").length };
}

/** Meals for the grocery maths: servings are the one person's portion of each slot. */
export function draftMeals(draft: AnonDraft): PlanMealRef[] {
  return draftToPlannedSlots(draft).map((slot) => ({
    recipeSlug: slot.recipeSlug,
    servings: draft.portions[portionKey(slot.date, slot.slot)] ?? 1,
  }));
}

/** Groceries for a draft, using only the library payload. Throws if the draft names a recipe the library lacks. */
export function anonGroceries(draft: AnonDraft, library: AnonLibrary): GroceryList {
  return buildGroceryList(draftMeals(draft), library.recipes, library.ingredients);
}
