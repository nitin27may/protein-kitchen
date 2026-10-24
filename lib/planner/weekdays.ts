import { addDays } from "./dates";
import type { IsoWeekday } from "../routines/types";

/** ISO weekday of a date (1 = Monday ... 7 = Sunday), computed in UTC so time zones cannot shift it. */
export function isoWeekdayOf(date: string): IsoWeekday {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (d === 0 ? 7 : d) as IsoWeekday;
}

export function isIsoWeekday(n: unknown): n is IsoWeekday {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 7;
}

/** The latest date on or before `date` that falls on `weekday`. Looks back at most six days. */
export function lastWeekdayOnOrBefore(date: string, weekday: IsoWeekday): string {
  const back = (isoWeekdayOf(date) - weekday + 7) % 7;
  return addDays(date, -back);
}
