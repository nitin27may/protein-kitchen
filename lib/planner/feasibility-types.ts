import type { IsoWeekday } from "../routines/types";

/** What the Review step asks the server: the same choices createPlan takes, no plan made. */
export interface FeasibilityInput {
  personIds: number[];
  startDate: string;
  endDate: string;
  mealTypes: ("breakfast" | "lunch" | "dinner" | "snack" | "shake")[];
  cuisineBalance: number;
  maxActiveMin: number | null;
  pinned: string[];
  healthFocus: { nutrientDense: boolean; lowSugar: boolean; light: boolean };
  prepStyle: "variety" | "leftovers" | "batch";
  prefs: Record<string, { liked: string[]; avoided: string[] }>;
}

export interface SlotFeasibility {
  slot: "breakfast" | "lunch" | "dinner" | "snack" | "shake";
  /** Recipes that pass every filter for this meal type. */
  eligible: number;
  /** Recipes that exist for this meal type before filters. */
  total: number;
  bestProteinG: number;
  medianProteinG: number;
}

export interface PersonReach {
  personId: number;
  name: string;
  targetG: number;
  /** A typical day built from median choices, and the best case from top choices. */
  typicalG: number;
  bestG: number;
  status: "reachable" | "tight" | "short";
}

export interface FeasibilityResult {
  slots: SlotFeasibility[];
  people: PersonReach[];
  /** Plain-language things to know, e.g. 'Only 3 breakfasts pass your avoids.' */
  notes: string[];
}

/** The three things to do after a plan is made. */
export const PLAN_STEPS = ["reviewed", "shopping", "prep"] as const;
export type PlanStep = (typeof PLAN_STEPS)[number];
export type PlanMilestones = Record<PlanStep, boolean>;

export type OptionalDay = IsoWeekday | null;
