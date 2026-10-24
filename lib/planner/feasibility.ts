import { datesBetween } from "./dates";
import type { FeasibilityInput, FeasibilityResult, PersonReach, SlotFeasibility } from "./feasibility-types";
import { eligible, isWeeknight, portionsFor, slotShares } from "./generate";
import type { Candidate, PersonTarget, PlanInput, Slot } from "./types";

/**
 * What the Review step shows before a plan is made: for each meal type how many recipes pass the choices so far, and
 * for each person whether their protein target can be reached on a typical day or only on a best day.
 *
 * Pure and read-only. It reuses the generator's own `eligible` and `portionsFor`, so the preview cannot disagree with what
 * the generator will actually allow. Healthy-focus choices are soft nudges in the generator and never remove a recipe,
 * so they are not filters here either; the only effect is that a typical day prefers low-sugar recipes when
 * enough of them exist.
 */

const SLOT_ORDER: readonly Slot[] = ["breakfast", "lunch", "dinner", "snack", "shake"];
const PLURAL: Record<Slot, string> = { breakfast: "breakfasts", lunch: "lunches", dinner: "dinners", snack: "snacks", shake: "shakes" };
/** A typical day counts as reaching the target at this share of it. */
const REACH_SHARE = 0.95;
/** Below this many recipes a meal type gets a note. */
const FEW_OPTIONS = 5;
/** Use the low-sugar subset for a typical day only when at least this many recipes pass. */
const MIN_LOW_SUGAR_POOL = 3;

const round1 = (n: number) => Math.round(n * 10) / 10;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Same slot rules as the generator, before any filter: shakes are only for the shake slot, sides and breads never stand alone. */
function existsForSlot(c: Candidate, slot: Slot): boolean {
  if (c.family === "sides" || c.family === "breads") return false;
  return slot === "shake" ? c.family === "shakes" : c.family !== "shakes" && c.mealSlots.includes(slot);
}

export function computeFeasibility(input: FeasibilityInput, candidates: readonly Candidate[], people: readonly PersonTarget[]): FeasibilityResult {
  const dates = datesBetween(input.startDate, input.endDate);
  const mealTypes = SLOT_ORDER.filter((s) => input.mealTypes.includes(s));
  const planInput: PlanInput = {
    dates,
    mealTypes,
    people,
    cuisineBalance: input.cuisineBalance,
    maxActiveMin: input.maxActiveMin,
    healthFocus: input.healthFocus,
    prepStyle: input.prepStyle,
    pinnedRecipes: input.pinned,
    locked: [],
    seed: 0,
  };
  // The strictest day decides what is always possible: weeknights carry the 20 minute limit unless a limit was chosen.
  const refDate = dates.find(isWeeknight) ?? dates[0] ?? input.startDate;
  const withoutAvoids: PlanInput = { ...planInput, people: people.map((p) => ({ ...p, avoided: new Set<string>() })) };

  const pool = new Map<Slot, Candidate[]>();
  const slots: SlotFeasibility[] = [];
  const notes: string[] = [];
  for (const slot of mealTypes) {
    const passing = candidates.filter((c) => eligible(c, slot, refDate, planInput));
    pool.set(slot, passing);
    const proteins = passing.map((c) => c.perServing.protein_g);
    slots.push({
      slot,
      eligible: passing.length,
      total: candidates.filter((c) => existsForSlot(c, slot)).length,
      bestProteinG: round1(Math.max(0, ...proteins)),
      medianProteinG: round1(median(proteins)),
    });
    if (passing.length === 0) {
      notes.push(`No recipes pass for ${slot}.`);
    } else if (passing.length < FEW_OPTIONS) {
      const ignoringAvoids = candidates.filter((c) => eligible(c, slot, refDate, withoutAvoids)).length;
      const n = passing.length;
      notes.push(`Only ${n} ${n === 1 ? slot : PLURAL[slot]} ${n === 1 ? "passes" : "pass"} your ${ignoringAvoids > n ? "avoids" : "choices"}.`);
    }
  }

  const shares = slotShares(mealTypes);
  const shakeCandidates = mealTypes.includes("shake") ? [] : candidates.filter((c) => eligible(c, "shake", refDate, planInput));
  const shakeShare = slotShares([...mealTypes, "shake"]).shake ?? 0;

  const reach: PersonReach[] = people.map((p) => {
    // The protein one serving at this person's portion gives for each recipe in a slot.
    const gramsFor = (c: Candidate, share: number) => (portionsFor(c, [p], share)[p.id] ?? 1) * c.perServing.protein_g;
    let typical = 0;
    let best = 0;
    for (const slot of mealTypes) {
      const share = shares[slot] ?? 0;
      const list = pool.get(slot) ?? [];
      if (list.length === 0) continue;
      const lowSugar = list.filter((c) => c.lowSugar);
      const typicalList = input.healthFocus.lowSugar && lowSugar.length >= MIN_LOW_SUGAR_POOL ? lowSugar : list;
      typical += median(typicalList.map((c) => gramsFor(c, share)));
      best += Math.max(...list.map((c) => gramsFor(c, share)));
    }
    const bestShake = shakeCandidates.length ? Math.max(...shakeCandidates.map((c) => gramsFor(c, shakeShare))) : 0;
    if (shakeCandidates.length && best < p.proteinTargetG && best + bestShake >= p.proteinTargetG) {
      const note = "Turning on a shake would close the gap.";
      if (!notes.includes(note)) notes.push(note);
    }
    const status: PersonReach["status"] = typical >= p.proteinTargetG * REACH_SHARE ? "reachable" : best >= p.proteinTargetG ? "tight" : "short";
    return { personId: Number(p.id), name: p.name, targetG: Math.round(p.proteinTargetG), typicalG: Math.round(typical), bestG: Math.round(best), status };
  });

  return { slots, people: reach, notes };
}
