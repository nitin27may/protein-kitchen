/**
 * Timer maths for cook mode. A timer stores the moment it ends (epoch ms), never a countdown, so a refresh, a
 * sleeping phone or a background tab cannot make it drift: the time left is always `endAt - now`.
 */

export interface CookTimer {
  id: string;
  stepId: string;
  /** What the timer is for, for example "Bake the patties". */
  label: string;
  partName: string | null;
  durationSec: number;
  /** Epoch ms when the timer ends. */
  endAt: number;
  /** The alert has already fired, so a refresh does not beep again. */
  alerted: boolean;
}

export const ADD_MS = 5 * 60 * 1000;

export const remainingMs = (endAt: number, now: number): number => Math.max(0, endAt - now);

export const isDone = (endAt: number, now: number): boolean => endAt <= now;

export function startTimer(args: { stepId: string; label: string; partName: string | null; durationSec: number }, now: number): CookTimer {
  return { id: `${args.stepId}@${now}`, stepId: args.stepId, label: args.label, partName: args.partName, durationSec: args.durationSec, endAt: now + args.durationSec * 1000, alerted: false };
}

/** Adds time. A timer that already finished restarts from now, so "add 5 minutes" always gives five more minutes. */
export function extendTimer(timer: CookTimer, ms: number, now: number): CookTimer {
  const base = isDone(timer.endAt, now) ? now : timer.endAt;
  return { ...timer, endAt: base + ms, alerted: false };
}

/** The running timer that ends first, or null when none is running. */
export function soonestRunning(timers: readonly CookTimer[], now: number): CookTimer | null {
  return timers.filter((t) => !isDone(t.endAt, now)).sort((a, b) => a.endAt - b.endAt)[0] ?? null;
}

/** Timers that just finished and have not alerted yet. */
export const needsAlert = (timers: readonly CookTimer[], now: number): CookTimer[] => timers.filter((t) => isDone(t.endAt, now) && !t.alerted);

/** "m:ss", rounding up so a timer never shows 0:00 while time is left. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Whole minutes left, rounded up, for a polite screen-reader announcement that does not change every second. */
export const minutesLeft = (ms: number): number => Math.ceil(Math.max(0, ms) / 60000);

export const timersKey = (recipeSlug: string, planId: number | null): string => `cook-timers:${recipeSlug}:${planId ?? "none"}`;

export const serializeTimers = (timers: readonly CookTimer[]): string => JSON.stringify(timers);

/** Reads timers back from storage. Anything malformed is dropped, so bad data never breaks the page. */
export function parseTimers(raw: string | null): CookTimer[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((v): CookTimer[] => {
      if (!v || typeof v !== "object") return [];
      const t = v as Record<string, unknown>;
      if (typeof t.id !== "string" || typeof t.stepId !== "string" || typeof t.label !== "string" || typeof t.durationSec !== "number" || typeof t.endAt !== "number") return [];
      return [{ id: t.id, stepId: t.stepId, label: t.label, partName: typeof t.partName === "string" ? t.partName : null, durationSec: t.durationSec, endAt: t.endAt, alerted: t.alerted === true }];
    });
  } catch {
    return [];
  }
}
