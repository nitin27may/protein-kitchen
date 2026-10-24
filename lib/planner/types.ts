import type { Macros } from "../schemas";

export type Slot = "breakfast" | "lunch" | "dinner" | "snack" | "shake";

export interface Candidate {
  slug: string;
  name: string;
  family: string;
  mealSlots: readonly string[];
  isIndian: boolean;
  activeMin: number;
  /** Hands-on minutes that can be done days earlier (parts that keep two days or more). Shown, never used to pick recipes. */
  makeAheadMin: number;
  perServing: Macros;
  /** Ingredients supplying at least 20 percent of the protein. */
  anchors: readonly string[];
  /** Every ingredient used, expanded through components. */
  ingredients: ReadonlySet<string>;
  /** Free sugars at or under 5 percent of the serving's energy. */
  lowSugar: boolean;
  /** Under the app's calorie ceiling for its slot. */
  light: boolean;
  /** In the top third of the library by NRF-style score. */
  nutrientDense: boolean;
  freeSugarG: number;
  nutrientScore: number;
  /** Keeps three days or more in the fridge, so it suits cooking ahead. */
  batchFriendly: boolean;
  fridgeDays: number;
  favourite: boolean;
  banned: boolean;
  rating: number | null;
  tested: boolean;
}

/** variety: every meal different. leftovers: dinner is eaten again as next day's lunch. batch: each lunch repeats for 2 to 3 days. */
export type PrepStyle = "variety" | "leftovers" | "batch";

export interface HealthFocus {
  nutrientDense: boolean;
  lowSugar: boolean;
  light: boolean;
}

export interface PersonTarget {
  id: string;
  name: string;
  proteinTargetG: number;
  kcalTarget: number | null;
  liked: ReadonlySet<string>;
  avoided: ReadonlySet<string>;
}

export interface LockedSlot {
  date: string;
  slot: Slot;
  recipeSlug: string;
}

export interface PlanInput {
  /** ISO dates, inclusive, in order. */
  dates: readonly string[];
  mealTypes: readonly Slot[];
  people: readonly PersonTarget[];
  prepStyle?: PrepStyle;
  /** Gentle nudges toward nutrient-dense, low-sugar and lighter meals. Omitted means no nudge. */
  healthFocus?: HealthFocus;
  /** 0 = all global, 1 = all Indian. */
  cuisineBalance: number;
  /** Applies to every day when set. Otherwise weekdays use 20. */
  maxActiveMin: number | null;
  pinnedRecipes: readonly string[];
  locked: readonly LockedSlot[];
  seed: number;
}

export interface PlannedSlot {
  date: string;
  slot: Slot;
  recipeSlug: string;
  /** Portion per person id, in quarter servings. */
  servings: Record<string, number>;
  locked: boolean;
  /** Eaten again from an earlier cook, not cooked fresh. */
  isLeftover?: boolean;
  /** Why this was chosen, shown in the swap sheet. */
  reasons: string[];
}

export interface DayPersonSummary {
  date: string;
  personId: string;
  proteinG: number;
  kcal: number;
  proteinTargetG: number;
  /** met: at or above target; near: within 15 percent; short: below that. */
  status: "met" | "near" | "short";
}

export type PlanWarning =
  | { type: "protein_gap"; date: string; personId: string; gapG: number; suggestion: "add_shake" | "choose_proteins" }
  | { type: "few_options"; date: string; slot: Slot; options: number }
  | { type: "liked_unused"; personId: string; ingredient: string }
  | { type: "pinned_unplaced"; recipeSlug: string };

export interface GeneratedPlan {
  slots: PlannedSlot[];
  days: DayPersonSummary[];
  warnings: PlanWarning[];
}
