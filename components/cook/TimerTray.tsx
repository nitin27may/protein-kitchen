"use client";

import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { formatClock, isDone, minutesLeft, remainingMs, soonestRunning } from "@/lib/recipes/cooktimers";
import type { CookTimer } from "@/lib/recipes/cooktimers";

interface TrayProps {
  timers: CookTimer[];
  now: number;
  announcement: string;
  onAddTime: (id: string) => void;
  onRemove: (id: string) => void;
}

/** A polite announcement that only changes when the whole minutes change, so a screen reader is not read a clock. */
function statusText(timers: CookTimer[], now: number, announcement: string): string {
  if (announcement) return announcement;
  const next = soonestRunning(timers, now);
  if (!next) return "";
  const running = timers.filter((t) => !isDone(t.endAt, now)).length;
  const m = minutesLeft(remainingMs(next.endAt, now));
  return `${running} ${running === 1 ? "timer" : "timers"} running. Next: ${next.label} in ${m} ${m === 1 ? "minute" : "minutes"}.`;
}

function Clock({ timer, now, size }: { timer: CookTimer; now: number; size: "lg" | "sm" }) {
  const done = isDone(timer.endAt, now);
  return (
    <span role="timer" aria-live="off" aria-label={done ? "Done" : `${formatClock(remainingMs(timer.endAt, now))} left`}
      className={`font-display font-bold tabular-nums ${size === "lg" ? "text-4xl" : "text-xl"} ${done ? "text-ok" : ""}`}>
      {done ? "Done" : formatClock(remainingMs(timer.endAt, now))}
    </span>
  );
}

/** Screen-reader status, rendered once. Phone bar and desktop panel both read the same timers. */
export function TimerStatus({ timers, now, announcement }: Pick<TrayProps, "timers" | "now" | "announcement">) {
  return <p className="sr-only" role="status" aria-live="polite">{statusText(timers, now, announcement)}</p>;
}

/** Phone: a compact row above the step. Hidden on desktop, where the panel shows the same timers. */
export function TimerBar({ timers, now, onAddTime, onRemove }: Omit<TrayProps, "announcement">) {
  const ordered = [...timers].sort((a, b) => a.endAt - b.endAt);
  if (!ordered.length) return null;
  return (
    <div className="-mx-5 mb-4 flex gap-2 overflow-x-auto px-5 pb-1 lg:hidden" aria-label="Timers">
      {ordered.map((t) => {
        const done = isDone(t.endAt, now);
        return (
          <div key={t.id} className={`flex shrink-0 items-center gap-2 rounded-card border px-3 py-1.5 ${done ? "border-ok bg-oksoft" : "border-line bg-surface"}`}>
            <div className="min-w-0">
              <p className="max-w-[9rem] truncate text-sm font-semibold leading-tight">{t.partName ?? t.label}</p>
              <Clock timer={t} now={now} size="sm" />
            </div>
            <Button variant="secondary" size="sm" className="min-w-11 px-2" onClick={() => onAddTime(t.id)} aria-label={`Add 5 minutes to ${t.label}`}>+5</Button>
            <Button variant="ghost" size="sm" className="min-w-11 px-2" onClick={() => onRemove(t.id)} aria-label={done ? `Dismiss ${t.label}` : `Cancel ${t.label}`}><XIcon className="size-4" /></Button>
          </div>
        );
      })}
    </div>
  );
}

/** Desktop: a sticky side panel. Hidden on phones, where the bar shows the same timers. */
export function TimerPanel({ timers, now, onAddTime, onRemove }: Omit<TrayProps, "announcement">) {
  const ordered = [...timers].sort((a, b) => a.endAt - b.endAt);
  return (
    <aside aria-label="Timers" className="hidden lg:sticky lg:top-4 lg:block lg:self-start">
      <div className="rounded-card border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold">Timers</h2>
        {ordered.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None running. Start one from a step that has a timer; it keeps running when you move on.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {ordered.map((t) => {
              const done = isDone(t.endAt, now);
              return (
                <li key={t.id} className={`rounded-control border p-3 ${done ? "border-ok bg-oksoft" : "border-line"}`}>
                  <p className="text-sm font-semibold leading-snug">{t.label}</p>
                  {t.partName ? <p className="text-xs text-muted">{t.partName}</p> : null}
                  <div className="mt-1"><Clock timer={t} now={now} size="lg" /></div>
                  <div className="mt-2 flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => onAddTime(t.id)}>Add 5 min</Button>
                    <Button variant="ghost" size="sm" onClick={() => onRemove(t.id)}>{done ? "Dismiss" : "Cancel"}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
