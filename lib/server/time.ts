/** The household's time zone. Dates in the app are calendar dates in this zone. */
export const APP_TZ = process.env.APP_TZ ?? "America/Toronto";

export function todayISO(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: APP_TZ });
}

/** Minutes since local midnight in the household's zone. `now` and `tz` are injectable so tests do not depend on the clock. */
export function localMinutes(now: Date = new Date(), tz: string = APP_TZ): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return num("hour") * 60 + num("minute");
}
