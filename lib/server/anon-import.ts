import type { Db } from "../db/client";
import { requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";
import { planMatchesDraft, type AnonDraft } from "../plan/anon-draft";
import { datesBetween } from "../planner/dates";
import { generatePlan, portionsFor, slotShares } from "../planner/generate";
import type { Candidate, PersonTarget, PlannedSlot, Slot } from "../planner/types";
import { PlanSetupSchema } from "../schemas";
import { persistHouseholdPlan } from "./household-plans";
import { planRoutineRowsFor } from "./routine-state";

export type ImportDraftResult =
  | { ok: true; planId: number; changed: boolean; libraryChanged: boolean; gaps: number }
  | { ok: false; error: string };

/** Same rules as the swap action: a known, allowed recipe for that slot that the target does not avoid. */
function usableForSlot(c: Candidate | undefined, slot: Slot, target: PersonTarget): c is Candidate {
  if (!c || c.banned || (c.rating !== null && c.rating <= 2)) return false;
  if (c.family === "sides" || c.family === "breads") return false;
  if (slot === "shake" ? c.family !== "shakes" : c.family === "shakes" || !c.mealSlots.includes(slot)) return false;
  return ![...target.avoided].some((a) => c.ingredients.has(a));
}

/**
 * Applies the meals the person chose on the device (swaps and locks) on top of the rebuilt plan. Each chosen recipe is
 * checked against the household's own candidates and the same slot rules as a swap; anything that fails keeps the
 * server's meal. Portions are never taken from the draft: a swapped meal is sized like a swap, the rest stay as built.
 */
function applyDraftChoices(draft: AnonDraft, built: readonly PlannedSlot[], candidates: readonly Candidate[], target: PersonTarget, mealTypes: readonly Slot[]): PlannedSlot[] {
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const chosen = new Map(draft.slots.map((d) => [`${d.date}|${d.slot}`, d]));
  const shares = slotShares(mealTypes);
  const resolved = new Map<string, PlannedSlot>();
  const put = (slot: PlannedSlot, next: PlannedSlot) => { resolved.set(`${slot.date}|${slot.slot}`, next); return next; };
  const previousDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  // Dinners first, then lunches: a leftover lunch depends on the dinner it repeats, which may itself have been swapped.
  const order = [...built].sort((a, b) => Number(a.slot === "lunch") - Number(b.slot === "lunch"));
  order.forEach((slot) => {
    const pick = chosen.get(`${slot.date}|${slot.slot}`);
    if (!pick) { put(slot, slot); return; }
    if (pick.recipeSlug === slot.recipeSlug) { put(slot, { ...slot, locked: pick.locked }); return; }
    const candidate = byslug.get(pick.recipeSlug);
    // A leftover is eaten again, not cooked, so it need not suit the slot: it only has to repeat last night's dinner
    // as it stands in the final plan and respect dislikes and bans (the generator's own leftover rule).
    const dinner = pick.isLeftover && slot.slot === "lunch" ? resolved.get(`${previousDay(slot.date)}|dinner`) : undefined;
    if (dinner && candidate && dinner.recipeSlug === candidate.slug && !candidate.banned && ![...target.avoided].some((a) => candidate.ingredients.has(a))) {
      put(slot, {
        ...slot, recipeSlug: candidate.slug, locked: pick.locked, isLeftover: true,
        servings: portionsFor(candidate, [target], shares[slot.slot] ?? 0.25), reasons: ["leftover from last night, no cooking"],
      });
      return;
    }
    if (!usableForSlot(candidate, slot.slot, target)) { put(slot, slot); return; }
    put(slot, {
      ...slot, recipeSlug: candidate.slug, locked: pick.locked, isLeftover: false,
      servings: portionsFor(candidate, [target], shares[slot.slot] ?? 0.25), reasons: ["chosen by you before signing up"],
    });
  });
  return built.map((slot) => resolved.get(`${slot.date}|${slot.slot}`) ?? slot);
}

/**
 * Rebuilds the plan on the server from the draft's seed and setup, then applies the validated meal choices. The draft's
 * portions are never saved; the final plan is compared with the draft so the caller can say the plan changed. The caller supplies the
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

  const slots = applyDraftChoices(draft, plan.slots, args.candidates, target, v.mealTypes as Slot[]);
  const libraryChanged = draft.libraryVersion !== args.libraryVersion;
  const changed = !planMatchesDraft(draft, slots, target.id);
  const routines = await planRoutineRowsFor(args.db, [personId], v.startDate, v.endDate, 0);
  const planId = await persistHouseholdPlan(args.db, access, {
    setup: {
      personIds: [personId], startDate: v.startDate, endDate: v.endDate, mealTypes: v.mealTypes, cuisineBalance: v.cuisineBalance,
      maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle,
      shoppingDay: v.shoppingDay ?? null, prepDay: v.prepDay ?? null, createdAt: args.now.toISOString(),
    },
    seed: draft.seed, slots, routines, recipeIds: args.recipeIds,
  });
  return { ok: true, planId, changed, libraryChanged, gaps: plan.warnings.filter((w) => w.type === "protein_gap").length };
}
