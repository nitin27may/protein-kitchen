import { addDays, datesBetween } from "../planner/dates";
import type { MealRow, PlanExport } from "./model";

/** What the fridge sheet shows, as plain data. The PDF builder only lays this out. */

export interface SchedulePrepTask {
  dueDate: string;
  text: string;
  forName: string;
}

export interface ScheduleEntry {
  name: string;
  leftover: boolean;
  /** Servings or portion for the people shown, short. Empty when nobody has a portion. */
  detail: string;
}

export interface ScheduleDay {
  date: string;
  weekday: string;
  dateLabel: string;
  /** Keyed by slot label. A missing key is an empty cell. */
  cells: Record<string, ScheduleEntry[]>;
}

export interface SchedulePrep {
  dayLabel: string;
  text: string;
}

export interface ScheduleWeek {
  n: number;
  from: string;
  to: string;
  title: string;
  days: ScheduleDay[];
  prep: SchedulePrep[];
}

export interface ScheduleModel {
  weeks: ScheduleWeek[];
  /** Column labels in print order. Shake appears only when the plan uses it. */
  slots: string[];
  audience: string;
  generatedOn: string;
}

export interface ScheduleOptions {
  /** Person id to print portions for. Omit for everyone. */
  personId?: number | null;
  /** 1-based week to print. Omit for every week. */
  week?: number | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BASE_SLOTS = ["Breakfast", "Lunch", "Snack", "Dinner"];

const weekdayOf = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;
/** "2 Nov". Built by hand so the output does not depend on the ICU build. */
export const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const withWeekday = (iso: string) => `${weekdayOf(iso).slice(0, 3)} ${shortDate(iso)}`;

/** "about 440 g" reads "440 g" on the fridge. A non-breaking space keeps the unit with its number. */
const short = (portion: string) => portion.replace(/^about /, "").replace(/ g$/, "\u00A0g");

function entriesFor(rows: MealRow[], everyone: boolean, peopleCount: number): ScheduleEntry[] {
  const byRecipe = new Map<string, MealRow[]>();
  for (const r of rows) {
    const key = `${r.leftover ? "L" : "F"}|${r.recipe}`;
    byRecipe.set(key, [...(byRecipe.get(key) ?? []), r]);
  }
  return [...byRecipe.values()].map((group) => {
    const first = group[0]!;
    const portion = short(first.portion);
    const perPerson = group.map((g) => `${g.person}: ${short(g.portion)}`);
    let detail: string;
    if (!everyone || peopleCount <= 1) detail = portion;
    else if (group.length === peopleCount && group.every((g) => g.portion === first.portion)) detail = `Each: ${portion}`;
    else detail = perPerson.join(" · ");
    return { name: first.recipe, leftover: first.leftover, detail };
  });
}

/** Returns undefined when `personId` or `week` do not exist in the plan. */
export function buildScheduleModel(plan: PlanExport, prep: readonly SchedulePrepTask[], options: ScheduleOptions = {}): ScheduleModel | undefined {
  const person = options.personId == null ? undefined : plan.people.find((p) => p.id === options.personId);
  if (options.personId != null && !person) return undefined;
  const chosen = options.week == null ? plan.weeks : plan.weeks.filter((w) => w.n === options.week);
  if (chosen.length === 0) return undefined;

  const meals = person ? plan.meals.filter((m) => m.person === person.name) : plan.meals;
  const slots = plan.meals.some((m) => m.slot === "Shake") ? [...BASE_SLOTS, "Shake"] : BASE_SLOTS;
  const audience = person ? `For ${person.name}` : plan.people.length > 1 ? `For everyone: ${plan.people.map((p) => p.name).join(", ")}` : plan.people.length === 1 ? `For ${plan.people[0]!.name}` : "For everyone";

  const weeks = chosen.map((w): ScheduleWeek => {
    const dates = datesBetween(w.from, w.to);
    const days = dates.map((date): ScheduleDay => {
      const cells: Record<string, ScheduleEntry[]> = {};
      for (const slot of slots) {
        const rows = meals.filter((m) => m.date === date && m.slot === slot);
        if (rows.length > 0) cells[slot] = entriesFor(rows, !person, plan.people.length);
      }
      return { date, weekday: weekdayOf(date), dateLabel: shortDate(date), cells };
    });
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const lo = addDays(first, -1);
    const tasks = prep.filter((t) => t.dueDate >= lo && t.dueDate <= last).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const byDay = new Map<string, string[]>();
    for (const t of tasks) byDay.set(t.dueDate, [...(byDay.get(t.dueDate) ?? []), `${t.forName}: ${t.text}`]);
    return {
      n: w.n,
      from: first,
      to: last,
      title: `Week of ${withWeekday(first)} to ${withWeekday(last)}`,
      days,
      prep: [...byDay].map(([date, texts]) => ({ dayLabel: `${weekdayOf(date).slice(0, 3)} night`, text: texts.join("; ") })),
    };
  });
  return { weeks, slots, audience, generatedOn: plan.generatedOn };
}
