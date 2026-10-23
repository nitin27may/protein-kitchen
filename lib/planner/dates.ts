/** Inclusive list of ISO dates between two ISO dates, computed in UTC. */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return out;
  for (let t = s; t <= e; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The next Monday strictly after `from`, or `from` itself when it is already a Monday. */
export function nextMonday(from: string): string {
  const d = new Date(`${from}T00:00:00Z`).getUTCDay();
  return addDays(from, (8 - d) % 7);
}

export function formatDay(date: string): { short: string; long: string } {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    short: d.toLocaleDateString("en-CA", { weekday: "short", timeZone: "UTC" }),
    long: d.toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }),
  };
}
