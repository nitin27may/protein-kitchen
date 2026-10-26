export interface HabitView {
  slug: string;
  title: string;
  grade: "strong" | "moderate" | "weak" | "myth" | "practical";
  note: string;
  caution: string | null;
  sourceUrl: string | null;
  done: boolean;
  defaultOn: boolean;
}

/** A night-before task as Today shows it. `key` is the shared tick key, so ticking here also ticks the prep guide. */
export interface PrepView {
  key: string;
  text: string;
  forName: string;
  dueDate: string;
  done: boolean;
}

export interface SnackView {
  slug: string;
  name: string;
  proteinG: number;
  kcal: number;
  minutes: number;
  needsCooking: boolean;
}

export interface MealView {
  id: number;
  slot: string;
  slug: string;
  name: string;
  proteinG: number;
  kcal: number;
  activeMin: number;
  leftover: boolean;
  image: string | null;
  thumbs: string[];
  /** Whether the person has answered this planned meal, set only for a signed-in person's own day. */
  log?: {
    status: "pending" | "eaten" | "swapped" | "skipped";
    entryUid: string | null;
    answerLabel: string | null;
    locked: boolean;
  };
}
