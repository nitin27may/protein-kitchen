"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setHabitDone } from "@/app/actions";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { CautionNote } from "@/components/routines/CautionNote";
import { EvidenceBadge } from "@/components/routines/EvidenceBadge";
import { Banner, Card } from "@/components/ui";
import { groupByTimeOfDay } from "@/lib/routines/schedule";
import { TIME_OF_DAY_LABEL } from "@/lib/routines/types";
import type { EvidenceGrade, TimeOfDay } from "@/lib/routines/types";

/** One routine scheduled today, with what the card needs to show and explain it. */
export interface RoutineItem {
  habitSlug: string;
  title: string;
  /** One plain line: what it is made of. */
  line: string;
  timeOfDay: TimeOfDay;
  done: boolean;
  soakHours: number | null;
  grade: EvidenceGrade;
  evidenceNote: string;
  caution: string | null;
}

/**
 * Today's routines for one person: tick each as you do it. Open in the morning, collapsed to "x of y done" later in the
 * day. Independent of any plan; the plan's snapshot drives groceries and prep, this is just the daily tick.
 */
export function MorningRoutines({ date, personId, items, chosenCount, defaultOpen }: { date: string; personId: number; items: RoutineItem[]; chosenCount: number; defaultOpen: boolean }) {
  const [list, setList] = useState(items);
  const [open, setOpen] = useState(defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  if (chosenCount === 0) {
    return (
      <p className="rounded-card border border-dashed border-line px-4 py-3 text-sm text-muted">
        No daily routine yet. <Link href={`/profiles/${personId}#daily-routine`} className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline">Add a morning routine</Link>
      </p>
    );
  }

  const doneCount = list.filter((r) => r.done).length;

  function tick(slug: string, done: boolean) {
    setError(null);
    setList((c) => c.map((r) => (r.habitSlug === slug ? { ...r, done } : r)));
    start(async () => {
      const res = await setHabitDone(date, personId, slug, done);
      if (!res.ok) {
        setList((c) => c.map((r) => (r.habitSlug === slug ? { ...r, done: !done } : r)));
        setError(res.error);
      }
    });
  }

  if (list.length === 0) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Morning routine</h2>
        <p className="mt-1 text-sm text-muted">Nothing is scheduled for today. <Link href={`/profiles/${personId}#daily-routine`} className="font-semibold text-primary underline-offset-2 hover:underline">Change routines</Link></p>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <button type="button" aria-expanded={open} aria-controls="routines-list" onClick={() => setOpen((o) => !o)}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-card px-4 text-left">
        <span className="text-lg font-semibold">Morning routine</span>
        <span className="flex items-center gap-2 text-sm text-muted tabular-nums">
          <span aria-live="polite">{doneCount} of {list.length} done</span>
          <ChevronDownIcon className={`size-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      <div className="mx-4 h-1.5 overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${doneCount} of ${list.length} routines done`}>
        <div className="h-full rounded-full bg-ok" style={{ width: `${(doneCount / list.length) * 100}%` }} />
      </div>

      {open ? (
        <div id="routines-list" className="space-y-3 px-4 pb-4 pt-3">
          {error ? <Banner tone="bad">{error}</Banner> : null}
          {groupByTimeOfDay(list).map((g) => (
            <section key={g.time} aria-label={TIME_OF_DAY_LABEL[g.time]}>
              <h3 className="text-sm font-semibold text-muted">{TIME_OF_DAY_LABEL[g.time]}</h3>
              <ul className="divide-y divide-line">
                {g.items.map((r) => (
                  <li key={r.habitSlug} className="py-1">
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 py-1">
                      <input type="checkbox" checked={r.done} onChange={(e) => tick(r.habitSlug, e.target.checked)} className="size-7 shrink-0 accent-[var(--primary)]" />
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 text-base font-semibold leading-snug ${r.done ? "text-muted line-through" : ""}`}>
                          {r.done ? <CheckIcon className="size-4 text-ok" /> : null}
                          {r.title}
                        </span>
                        <span className={`block text-sm text-muted`}>{r.line}{r.soakHours ? " Needs soaking the night before." : ""}</span>
                      </span>
                    </label>
                    <details className="pb-1 pl-10">
                      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-primary">About this</summary>
                      <div className="mt-1 space-y-2">
                        <EvidenceBadge grade={r.grade} />
                        <p className="text-sm">{r.evidenceNote}</p>
                        <CautionNote caution={r.caution} />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : <div className="h-3" />}
    </Card>
  );
}
