/** Local clock time (HH:MM) and calendar date in a time zone. */
export function localParts(now: Date, tz: string): { date: string; hhmm: string } {
  const date = now.toLocaleDateString("en-CA", { timeZone: tz });
  const hhmm = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return { date, hhmm };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** A reminder goes out at or after its time, never more than `windowMin` late, and at most once a day. */
export function isReminderDue(reminderTime: string | null, now: Date, tz: string, alreadySentToday: boolean, windowMin = 30): boolean {
  if (!reminderTime || alreadySentToday) return false;
  const { hhmm } = localParts(now, tz);
  const late = minutes(hhmm) - minutes(reminderTime);
  return late >= 0 && late <= windowMin;
}

export interface ReminderMessage {
  title: string;
  body: string;
  url: string;
}

/** Short enough for a lock screen: lists up to three tasks and counts the rest. */
export function buildReminder(name: string, tasks: readonly string[]): ReminderMessage | null {
  if (tasks.length === 0) return null;
  const shown = tasks.slice(0, 3).map((t) => t.replace(/, for .*$/, ""));
  const more = tasks.length > 3 ? ` and ${tasks.length - 3} more` : "";
  return {
    title: `${name}: prep for tomorrow`,
    body: `${shown.join("; ")}${more}`,
    url: "/",
  };
}
