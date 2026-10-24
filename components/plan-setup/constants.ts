import type { IsoWeekday } from "@/lib/routines/types";
import type { MealType, PrepStyle, TimeLimit } from "@/lib/plan/wizard";

export const MEALS: { id: MealType; label: string }[] = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "dinner", label: "Dinner" },
  { id: "snack", label: "Snack" },
  { id: "shake", label: "Shake" },
];

export const STYLE_LABEL: Record<PrepStyle, string> = { variety: "Variety", leftovers: "Cook once, eat twice", batch: "Batch cook" };

export const STYLE_OPTIONS: [PrepStyle, string, string][] = [
  ["variety", "Variety", "Different meals every day. Most cooking."],
  ["leftovers", "Cook once, eat twice", "Dinner is eaten again as the next day's lunch."],
  ["batch", "Batch cook", "Each lunch repeats for 2 to 3 days. Least cooking."],
];

export const TIME_LIMIT_LABEL: Record<TimeLimit, string> = { weeknights: "Weeknights 20 minutes or less", always20: "Every day 20 minutes or less", none: "No time limit" };

export const TIME_HINT: Record<TimeLimit, string> = {
  weeknights: "Weeknights keep active cooking to 20 minutes or less. Weekends can be longer.",
  always20: "Every meal is 20 minutes or less of active cooking.",
  none: "Any recipe can be picked, however long it takes.",
};

export const WEEKDAY_NAME: Record<IsoWeekday, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };

export function fmtRange(start: string, end: string): string {
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} to ${f(end)}`;
}

export function listNames(list: string[], max = 4): string {
  if (list.length === 0) return "None";
  return list.length > max ? `${list.slice(0, max).join(", ")} and ${list.length - max} more` : list.join(", ");
}
