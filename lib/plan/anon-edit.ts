import { datesBetween } from "../planner/dates";
import { generatePlan, portionsFor, slotShares, summariseDays, suggestSwaps } from "../planner/generate";
import type { Candidate, DayPersonSummary, GeneratedPlan, PlanInput, PlannedSlot, Slot } from "../planner/types";
import {
  ANON_PERSON_ID, anonProfileToTarget, buildAnonDraft, draftToPlannedSlots, portionKey, AnonDraftSchema,
  type AnonDraft, type AnonProfile,
} from "./anon-draft";
import { planInputFor } from "./anon-generate";
import type { AnonLibrary } from "./anon-library";

/**
 * Edits to a draft that stay on the device: swap, lock, portions, regenerate, add a shake. Pure functions from a draft to
 * a new draft, using only the library payload. Nothing here touches storage or the network.
 */

export interface DraftSwapOption {
  slug: string;
  name: string;
  proteinG: number;
  kcal: number;
  activeMin: number;
  reason: string;
}

export type DraftEdit = { ok: true; draft: AnonDraft } | { ok: false; error: string };

const bySlug = (library: AnonLibrary) => new Map(library.candidates.map((c) => [c.slug, c]));

/** The planner's input for a draft, with its locked meals pinned in place. */
export function draftPlanInput(draft: AnonDraft, profile: AnonProfile): PlanInput {
  const base = planInputFor(draft.setup, profile, draft.seed);
  return {
    ...base,
    locked: draft.slots.filter((s) => s.locked && !s.isLeftover).map((s) => ({ date: s.date, slot: s.slot as Slot, recipeSlug: s.recipeSlug })),
  };
}

/** What the plan screen shows: the meals and each day's protein against the target. */
export function draftDays(draft: AnonDraft, profile: AnonProfile, library: AnonLibrary): { slots: PlannedSlot[]; days: DayPersonSummary[] } {
  const slots = draftToPlannedSlots(draft);
  const input = draftPlanInput(draft, profile);
  return { slots, days: summariseDays(slots, input.people, bySlug(library), input.dates) };
}

export function draftSwapOptions(draft: AnonDraft, profile: AnonProfile, library: AnonLibrary, ref: { date: string; slot: string }): DraftSwapOption[] {
  const input = draftPlanInput(draft, profile);
  const { slots, days } = draftDays(draft, profile, library);
  const plan: GeneratedPlan = { slots, days, warnings: [] };
  return suggestSwaps(plan, { date: ref.date, slot: ref.slot as Slot }, input, library.candidates, 3).map((c) => {
    const liked = input.people.some((p) => [...p.liked].some((l) => c.ingredients.has(l)));
    return {
      slug: c.slug, name: c.name, proteinG: Math.round(c.perServing.protein_g * 10) / 10, kcal: Math.round(c.perServing.kcal),
      activeMin: c.activeMin, reason: liked ? "Uses an ingredient you like" : `${c.activeMin} min of work`,
    };
  });
}

function replaceSlot(draft: AnonDraft, ref: { date: string; slot: string }, change: (s: AnonDraft["slots"][number]) => AnonDraft["slots"][number]): AnonDraft["slots"] | null {
  let found = false;
  const slots = draft.slots.map((s) => {
    if (s.date !== ref.date || s.slot !== ref.slot) return s;
    found = true;
    return change(s);
  });
  return found ? slots : null;
}

export function swapDraftSlot(draft: AnonDraft, profile: AnonProfile, library: AnonLibrary, ref: { date: string; slot: string }, recipeSlug: string): DraftEdit {
  const candidate: Candidate | undefined = bySlug(library).get(recipeSlug);
  if (!candidate) return { ok: false, error: "Could not swap that meal" };
  const slots = replaceSlot(draft, ref, (s) => ({ date: s.date, slot: s.slot, recipeSlug, locked: s.locked }));
  if (!slots) return { ok: false, error: "Meal not found in this plan." };
  const target = anonProfileToTarget(profile);
  const shares = slotShares(draft.setup.mealTypes as Slot[]);
  const servings = portionsFor(candidate, [target], shares[ref.slot] ?? 0.25)[ANON_PERSON_ID] ?? 1;
  const portions = { ...draft.portions, [portionKey(ref.date, ref.slot)]: clampQuarter(servings) };
  return { ok: true, draft: AnonDraftSchema.parse({ ...draft, slots, portions }) };
}

export function toggleDraftLock(draft: AnonDraft, ref: { date: string; slot: string }, locked: boolean): DraftEdit {
  const slots = replaceSlot(draft, ref, (s) => ({ ...s, locked }));
  if (!slots) return { ok: false, error: "Meal not found in this plan." };
  return { ok: true, draft: AnonDraftSchema.parse({ ...draft, slots }) };
}

export function setDraftPortion(draft: AnonDraft, ref: { date: string; slot: string }, servings: number): DraftEdit {
  if (!Number.isFinite(servings) || !(servings >= 0.25 && servings <= 4)) return { ok: false, error: "Servings must be between 0.25 and 4" };
  if (!draft.slots.some((s) => s.date === ref.date && s.slot === ref.slot)) return { ok: false, error: "Meal not found in this plan." };
  const portions = { ...draft.portions, [portionKey(ref.date, ref.slot)]: clampQuarter(servings) };
  return { ok: true, draft: AnonDraftSchema.parse({ ...draft, portions }) };
}

/** A new draft from a new seed. Locked meals are kept. */
export function regenerateDraft(draft: AnonDraft, profile: AnonProfile, library: AnonLibrary, seed: number, now: Date, mealTypes?: readonly Slot[]): DraftEdit {
  const setup = mealTypes ? { ...draft.setup, mealTypes: [...mealTypes] } : draft.setup;
  const next = { ...draft, setup, seed };
  const input = draftPlanInput(next, profile);
  const plan = generatePlan({ ...input, dates: datesBetween(setup.startDate, setup.endDate) }, library.candidates);
  if (plan.slots.length === 0) return { ok: false, error: "No recipes match these choices. Remove an avoided ingredient or relax the time limit." };
  return { ok: true, draft: buildAnonDraft({ setup, seed, plan, libraryVersion: draft.libraryVersion, now, profileRef: draft.profileRef }) };
}

export function enableDraftShake(draft: AnonDraft, profile: AnonProfile, library: AnonLibrary, seed: number, now: Date): DraftEdit {
  if (draft.setup.mealTypes.includes("shake")) return { ok: true, draft };
  return regenerateDraft(draft, profile, library, seed, now, [...(draft.setup.mealTypes as Slot[]), "shake"]);
}

const clampQuarter = (n: number) => Math.min(4, Math.max(0.25, Math.round(n * 4) / 4));
