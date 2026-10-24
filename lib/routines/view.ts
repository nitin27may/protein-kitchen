import { ALL_DAYS, DAY_LABEL, TIMES_OF_DAY, TIME_OF_DAY_LABEL } from "./types";
import type { EvidenceGrade, IsoWeekday, PersonRoutineView, PlanRoutineView, RoutineOption, TimeOfDay } from "./types";

/** Pure display helpers for daily routines. No data access, safe in the browser. */

const WEEKDAYS: IsoWeekday[] = [1, 2, 3, 4, 5];
const WEEKENDS: IsoWeekday[] = [6, 7];

/** Days sorted Monday first, without repeats or values outside 1 to 7. */
export function normaliseDays(days: readonly number[]): IsoWeekday[] {
  return ALL_DAYS.filter((d) => days.includes(d));
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** 'Every day', 'Weekdays', 'Weekends' or 'Mon, Wed, Fri'. */
export function describeDays(days: readonly number[]): string {
  const d = normaliseDays(days);
  if (d.length === 0) return "No days";
  if (d.length === 7) return "Every day";
  if (sameSet(d, WEEKDAYS)) return "Weekdays";
  if (sameSet(d, WEEKENDS)) return "Weekends";
  return d.map((x) => DAY_LABEL[x]).join(", ");
}

/** The same, for use inside a sentence: 'every day', 'on weekdays', 'on weekends', 'on Mon, Wed, Fri'. */
export function daysPhrase(days: readonly number[]): string {
  const d = normaliseDays(days);
  if (d.length === 7) return "every day";
  if (d.length === 0) return "on no days";
  if (sameSet(d, WEEKDAYS)) return "on weekdays";
  if (sameSet(d, WEEKENDS)) return "on weekends";
  return `on ${d.map((x) => DAY_LABEL[x]).join(", ")}`;
}

export const everyDay = (): IsoWeekday[] => [...ALL_DAYS];
export const weekdays = (): IsoWeekday[] => [...WEEKDAYS];
export const isEveryDay = (days: readonly number[]) => normaliseDays(days).length === 7;
export const isWeekdays = (days: readonly number[]) => sameSet(normaliseDays(days), WEEKDAYS);

/** Adds or removes one day. Removing the last day is refused (returns the same days): a routine on no day is just off. */
export function toggleDay(days: readonly number[], day: IsoWeekday): IsoWeekday[] {
  const current = normaliseDays(days);
  if (current.includes(day)) {
    if (current.length === 1) return current;
    return current.filter((d) => d !== day);
  }
  return normaliseDays([...current, day]);
}

export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 4;

/** Steps servings by a half, kept between 1 and 4. */
export function stepServings(current: number, direction: 1 | -1): number {
  const next = Math.round((current + direction * 0.5) * 2) / 2;
  return Math.min(SERVINGS_MAX, Math.max(SERVINGS_MIN, next));
}

const timeIndex = (t: TimeOfDay) => TIMES_OF_DAY.indexOf(t);

/** Chosen (active) routines first, then by time of day, then by title. Does not change its input. */
export function sortRoutines(options: readonly RoutineOption[], chosen: readonly PersonRoutineView[]): RoutineOption[] {
  const active = new Set(chosen.filter((c) => c.active).map((c) => c.habitSlug));
  return [...options].sort((a, b) => {
    const ca = active.has(a.habitSlug) ? 0 : 1;
    const cb = active.has(b.habitSlug) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const ta = timeIndex(a.timeOfDay) - timeIndex(b.timeOfDay);
    if (ta !== 0) return ta;
    return a.title.localeCompare(b.title);
  });
}

export interface TimeGroup {
  time: TimeOfDay;
  label: string;
  options: RoutineOption[];
}

/** Options grouped by time of day in day order, empty groups left out. Keeps the input order inside each group. */
export function groupByTime(options: readonly RoutineOption[]): TimeGroup[] {
  return TIMES_OF_DAY.map((time) => ({ time, label: TIME_OF_DAY_LABEL[time], options: options.filter((o) => o.timeOfDay === time) })).filter((g) => g.options.length > 0);
}

/** Group headings only appear once the list is long enough to need them. */
export const GROUP_THRESHOLD = 5;
export const shouldGroup = (count: number) => count > GROUP_THRESHOLD;

/** Lower-cases the first letter of a catalog name unless it looks like an acronym ('IFCT seeds'). */
function inSentence(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 1 && trimmed[1] === trimmed[1]!.toUpperCase() && trimmed[1] !== trimmed[1]!.toLowerCase()) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** 'Made from fenugreek seed and water.' Built only from the catalog's ingredient names. */
export function summaryLine(option: Pick<RoutineOption, "items">): string {
  const names = option.items.map((i) => inSentence(i.name)).filter((n, i, all) => n && all.indexOf(n) === i);
  if (names.length === 0) return "";
  if (names.length === 1) return `Made from ${names[0]}.`;
  return `Made from ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
}

export const SOAK_LINE = "Soak the night before";
export const soakLine = (option: Pick<RoutineOption, "soakHours">): string | null => (option.soakHours ? SOAK_LINE : null);

/** What the routine starts as when a person first turns it on. */
export function defaultsFor(option: RoutineOption): { days: IsoWeekday[]; timeOfDay: TimeOfDay; servings: number } {
  return { days: normaliseDays(option.defaultDays).length ? normaliseDays(option.defaultDays) : everyDay(), timeOfDay: option.timeOfDay, servings: 1 };
}

export const GRADE_WORD: Record<EvidenceGrade, string> = { strong: "Strong", moderate: "Moderate", weak: "Weak", practical: "Practical", myth: "Not supported" };

/** One plain sentence on what each grade means. The grade word is always shown beside it, so colour is never the only signal. */
export const GRADE_MEANING: Record<EvidenceGrade, string> = {
  strong: "Reliable evidence from human studies.",
  moderate: "Some human studies.",
  weak: "Traditional use or lab studies only.",
  practical: "No health claim. It just makes cooking work.",
  myth: "Not supported by the evidence.",
};

export const MEDICAL_NOTE = "This is a food habit, not medical advice. Ask your doctor first if you take regular medicine or are pregnant.";

export interface PlanRoutineRow {
  personId: number;
  habitSlug: string;
  title: string;
  timeOfDay: TimeOfDay;
  timeLabel: string;
  days: IsoWeekday[];
  daysLabel: string;
  daysPhrase: string;
  servings: number;
  soak: boolean;
}

/** Joins what a plan kept with the catalog's titles, ordered by person, then time of day, then title. */
export function planRoutineRows(planRoutines: readonly PlanRoutineView[], catalog: readonly RoutineOption[]): PlanRoutineRow[] {
  const byHabit = new Map(catalog.map((o) => [o.habitSlug, o]));
  return planRoutines
    .map((r) => {
      const option = byHabit.get(r.habitSlug);
      const days = normaliseDays(r.days);
      return {
        personId: r.personId,
        habitSlug: r.habitSlug,
        title: option?.title ?? r.habitSlug,
        timeOfDay: r.timeOfDay,
        timeLabel: TIME_OF_DAY_LABEL[r.timeOfDay],
        days,
        daysLabel: describeDays(days),
        daysPhrase: daysPhrase(days),
        servings: r.servings,
        soak: !!option?.soakHours,
      };
    })
    .sort((a, b) => a.personId - b.personId || timeIndex(a.timeOfDay) - timeIndex(b.timeOfDay) || a.title.localeCompare(b.title));
}
