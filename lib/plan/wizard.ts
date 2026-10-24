import type { FeasibilityInput, FeasibilityResult, OptionalDay } from "../planner/feasibility-types";
import { addDays, datesBetween } from "../planner/dates";
import { ALL_DAYS } from "../routines/types";
import { MAX_PLAN_DAYS } from "../schemas";
import type { IsoWeekday } from "../routines/types";

/** Pure logic for the guided plan setup: step order, the draft kept between steps, validation and blockers. */

export const WIZARD_STEPS = ["who", "meals", "food", "routine", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABEL: Record<WizardStep, string> = {
  who: "Who and when",
  meals: "Meals and effort",
  food: "Food",
  routine: "Daily routine",
  review: "Review",
};

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "shake"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const DRAFT_VERSION = 1;
export const DRAFT_KEY = "pk-plan-draft";

export type PlanLength = "7" | "14" | "custom";
export type TimeLimit = "weeknights" | "always20" | "none";
export type PrepStyle = "variety" | "leftovers" | "batch";
export interface PrefLists { liked: string[]; avoided: string[] }
export interface HealthFocus { nutrientDense: boolean; lowSugar: boolean; light: boolean }

/** Everything the person has chosen so far. Plain data, so it can sit in sessionStorage as JSON. */
export interface WizardDraft {
  personIds: number[];
  length: PlanLength;
  start: string;
  customEnd: string;
  shoppingDay: OptionalDay;
  prepDay: OptionalDay;
  meals: MealType[];
  prepStyle: PrepStyle;
  timeLimit: TimeLimit;
  cuisine: number;
  health: HealthFocus;
  pinned: string[];
  prefs: Record<number, PrefLists>;
}

export interface StepProblem {
  /** Which part of the step the message belongs to, so the screen can put it beside the control. */
  field: "people" | "dates" | "meals";
  message: string;
}

// ---------- Steps ----------

export const isWizardStep = (value: unknown): value is WizardStep => typeof value === "string" && (WIZARD_STEPS as readonly string[]).includes(value);

export function parseStep(raw: string | null | undefined): WizardStep | null {
  return isWizardStep(raw) ? raw : null;
}

export const stepIndex = (step: WizardStep): number => WIZARD_STEPS.indexOf(step);
export const stepNumber = (step: WizardStep): number => stepIndex(step) + 1;

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) - 1] ?? null;
}

/** Steps that may be skipped: every step except the first and the review itself. */
export const canSkip = (step: WizardStep): boolean => step !== "who" && step !== "review";

/** With no ?step in the address: a repeat run opens on the review, the first run starts at the beginning. */
export function openingStep(requested: string | null | undefined, hasLastPlan: boolean): WizardStep {
  return parseStep(requested) ?? (hasLastPlan ? "review" : "who");
}

// ---------- Dates ----------

export function draftEnd(d: Pick<WizardDraft, "length" | "start" | "customEnd">): string {
  if (!d.start) return d.customEnd;
  return d.length === "7" ? addDays(d.start, 6) : d.length === "14" ? addDays(d.start, 13) : d.customEnd;
}

export function draftDayCount(d: Pick<WizardDraft, "length" | "start" | "customEnd">): number {
  if (!d.start || !draftEnd(d)) return 0;
  return datesBetween(d.start, draftEnd(d)).length;
}

export function dateProblem(d: Pick<WizardDraft, "length" | "start" | "customEnd">): string | null {
  if (!d.start) return "Choose a start date.";
  const count = draftDayCount(d);
  if (count < 1) return "The end date is before the start date.";
  if (count > MAX_PLAN_DAYS) return `A plan can cover at most ${MAX_PLAN_DAYS} days.`;
  return null;
}

// ---------- Validation ----------

/** Problems that stop a step from moving on. Skipping never validates: it keeps the remembered values. */
export function validateStep(step: WizardStep, d: WizardDraft): StepProblem[] {
  const problems: StepProblem[] = [];
  if (step === "who" || step === "review") {
    if (d.personIds.length === 0) problems.push({ field: "people", message: "Choose at least one person." });
    const dates = dateProblem(d);
    if (dates) problems.push({ field: "dates", message: dates });
  }
  if (step === "meals" || step === "review") {
    if (d.meals.length === 0) problems.push({ field: "meals", message: "Choose at least one meal type." });
  }
  return problems;
}

/** The first step with a problem, so a jump to the review can send the person back to fix it. */
export function firstInvalidStep(d: WizardDraft): WizardStep | null {
  for (const step of WIZARD_STEPS) if (validateStep(step, d).length) return step;
  return null;
}

// ---------- Feasibility ----------

const SLOT_WORD: Record<MealType, string> = { breakfast: "breakfast", lunch: "lunch", dinner: "dinner", snack: "snack", shake: "shake" };

/**
 * Reasons Generate must stay off. Draft problems first, then the planner's own answer: a requested meal type with
 * no recipe left, or a person whose target cannot be approached at all. A person who is only 'short' can still go on.
 */
export function blockers(d: WizardDraft, feasibility: FeasibilityResult | null): string[] {
  const out = validateStep("review", d).map((p) => p.message);
  if (!feasibility) return out;
  for (const s of feasibility.slots) {
    if (d.meals.includes(s.slot) && s.eligible === 0) {
      const word = SLOT_WORD[s.slot];
      out.push(`No ${word} recipes fit your choices. Avoid fewer foods, or turn ${word} off.`);
    }
  }
  for (const p of feasibility.people) {
    if (p.status === "short" && p.bestG <= 0) out.push(`${p.name} has no recipes that count towards a protein target. Change the meals or avoids.`);
  }
  return out;
}

/** True when a shake would help and is not already on: the planner's notes say so in plain words. */
export function shakeFix(d: WizardDraft, feasibility: FeasibilityResult | null): boolean {
  if (!feasibility || d.meals.includes("shake")) return false;
  const shortOrTight = feasibility.people.some((p) => p.status !== "reachable");
  return shortOrTight && feasibility.notes.some((n) => /shake/i.test(n));
}

export function withShake(d: WizardDraft): WizardDraft {
  return d.meals.includes("shake") ? d : { ...d, meals: [...d.meals, "shake"] };
}

// ---------- Mapping to the actions ----------

export function toFeasibilityInput(d: WizardDraft): FeasibilityInput {
  return {
    personIds: d.personIds,
    startDate: d.start,
    endDate: draftEnd(d),
    mealTypes: [...d.meals],
    cuisineBalance: d.cuisine,
    maxActiveMin: d.timeLimit === "always20" ? 20 : d.timeLimit === "none" ? 999 : null,
    pinned: d.pinned,
    healthFocus: d.health,
    prepStyle: d.prepStyle,
    prefs: Object.fromEntries(d.personIds.map((id) => [String(id), d.prefs[id] ?? { liked: [], avoided: [] }])),
  };
}

export type CreatePlanDraftInput = FeasibilityInput & { shoppingDay: OptionalDay; prepDay: OptionalDay };

export function toCreatePlanInput(d: WizardDraft): CreatePlanDraftInput {
  return { ...toFeasibilityInput(d), shoppingDay: d.shoppingDay, prepDay: d.prepDay };
}

/** Stable text for a draft's feasibility inputs, to tell whether a new check is needed. */
export const feasibilityKey = (d: WizardDraft): string => JSON.stringify(toFeasibilityInput(d));

// ---------- Draft storage ----------

export function serializeDraft(d: WizardDraft): string {
  return JSON.stringify({ v: DRAFT_VERSION, draft: d });
}

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
const isDay = (x: unknown): x is IsoWeekday => typeof x === "number" && (ALL_DAYS as number[]).includes(x);
const isDate = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

function sanitizePrefs(raw: unknown, valid: Set<number> | null): Record<number, PrefLists> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<number, PrefLists> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || (valid && !valid.has(id))) continue;
    const v = value as { liked?: unknown; avoided?: unknown } | null;
    if (!v || !isStringArray(v.liked) || !isStringArray(v.avoided)) continue;
    out[id] = { liked: v.liked, avoided: v.avoided };
  }
  return out;
}

/**
 * Reads a saved draft. Anything wrong (bad JSON, another version, a missing field) falls back to `fallback` for that
 * field, or for the whole draft when the text is not usable. People who no longer exist are dropped.
 */
export function parseDraft(raw: string | null | undefined, fallback: WizardDraft, validPersonIds?: readonly number[]): WizardDraft {
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const wrapper = parsed as { v?: unknown; draft?: unknown };
  if (wrapper.v !== DRAFT_VERSION || !wrapper.draft || typeof wrapper.draft !== "object") return fallback;
  const d = wrapper.draft as Record<string, unknown>;
  const valid = validPersonIds ? new Set(validPersonIds) : null;

  const personIds = Array.isArray(d.personIds) ? d.personIds.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && (!valid || valid.has(x))) : null;
  const meals = Array.isArray(d.meals) ? d.meals.filter((x): x is MealType => (MEAL_TYPES as readonly unknown[]).includes(x)) : null;
  const health = d.health && typeof d.health === "object" ? (d.health as Record<string, unknown>) : null;

  return {
    personIds: personIds && personIds.length ? personIds : fallback.personIds,
    length: d.length === "7" || d.length === "14" || d.length === "custom" ? d.length : fallback.length,
    start: isDate(d.start) ? d.start : fallback.start,
    customEnd: isDate(d.customEnd) ? d.customEnd : fallback.customEnd,
    shoppingDay: d.shoppingDay === null ? null : isDay(d.shoppingDay) ? d.shoppingDay : fallback.shoppingDay,
    prepDay: d.prepDay === null ? null : isDay(d.prepDay) ? d.prepDay : fallback.prepDay,
    meals: meals ?? fallback.meals,
    prepStyle: d.prepStyle === "variety" || d.prepStyle === "leftovers" || d.prepStyle === "batch" ? d.prepStyle : fallback.prepStyle,
    timeLimit: d.timeLimit === "weeknights" || d.timeLimit === "always20" || d.timeLimit === "none" ? d.timeLimit : fallback.timeLimit,
    cuisine: typeof d.cuisine === "number" && d.cuisine >= 0 && d.cuisine <= 1 ? d.cuisine : fallback.cuisine,
    health:
      health && typeof health.nutrientDense === "boolean" && typeof health.lowSugar === "boolean" && typeof health.light === "boolean"
        ? { nutrientDense: health.nutrientDense, lowSugar: health.lowSugar, light: health.light }
        : fallback.health,
    pinned: isStringArray(d.pinned) ? d.pinned : fallback.pinned,
    prefs: sanitizePrefs(d.prefs, valid) ?? fallback.prefs,
  };
}
