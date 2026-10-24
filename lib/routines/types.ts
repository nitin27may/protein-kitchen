/** Daily routines: small things eaten or drunk on a schedule (methi water, soaked almonds). Evidence-graded, no doses. */
export const TIMES_OF_DAY = ["waking", "morning", "breakfast", "evening", "bedtime"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  waking: "On waking",
  morning: "Mid-morning",
  breakfast: "With breakfast",
  evening: "Evening",
  bedtime: "At bedtime",
};

/** ISO weekday numbers: 1 = Monday ... 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ALL_DAYS: IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];
export const DAY_LABEL: Record<IsoWeekday, string> = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };

export type EvidenceGrade = "strong" | "moderate" | "weak" | "myth" | "practical";

/** One routine a person can choose, built from data/habits.json and its routine recipe. */
export interface RoutineOption {
  habitSlug: string;
  title: string;
  recipeSlug: string;
  timeOfDay: TimeOfDay;
  defaultDays: IsoWeekday[];
  grade: EvidenceGrade;
  evidenceNote: string;
  caution: string | null;
  sourceUrl: string | null;
  /** Hours to soak the night before; null when nothing needs soaking. */
  soakHours: number | null;
  items: { slug: string; name: string; grams: number }[];
}

/** A person's choice (human-owned, exported). */
export interface PersonRoutineView {
  habitSlug: string;
  active: boolean;
  days: IsoWeekday[];
  timeOfDay: TimeOfDay;
  servings: number;
}

/** What a plan took from each person's choices when it was generated (plan state, not exported). */
export interface PlanRoutineView {
  planId: number;
  personId: number;
  habitSlug: string;
  days: IsoWeekday[];
  timeOfDay: TimeOfDay;
  servings: number;
}
