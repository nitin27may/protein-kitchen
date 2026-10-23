/** The household's time zone. Dates in the app are calendar dates in this zone. */
export const APP_TZ = process.env.APP_TZ ?? "America/Toronto";

export function todayISO(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: APP_TZ });
}
