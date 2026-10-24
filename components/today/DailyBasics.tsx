"use client";

import { useState, useTransition } from "react";
import { setHabitDone } from "@/app/actions";
import { ChevronDownIcon } from "@/components/icons";
import { Sheet } from "@/components/Sheet";
import { Banner, Button, Card, Pill, SwitchRow } from "@/components/ui";
import type { Tone } from "@/components/ui";
import type { HabitView } from "./types";

const GRADE_TONE: Record<HabitView["grade"], Tone> = { strong: "ok", moderate: "info", practical: "info", weak: "warn", myth: "bad" };
const GRADE_LABEL: Record<HabitView["grade"], string> = {
  strong: "Strong evidence",
  moderate: "Some evidence",
  practical: "Practical, no health claim",
  weak: "Weak evidence",
  myth: "Myth",
};

/**
 * The daily basics checklist. Collapsed to one line ("3 of 8 done") except in the morning, when it is what you came for.
 * Habits that are routines (methi water and so on) are not listed here; they have their own card, MorningRoutines.
 */
export function DailyBasics({ date, personId, habits, defaultOpen }: { date: string; personId: number; habits: HabitView[]; defaultOpen: boolean }) {
  const [hs, setHs] = useState(habits);
  const [open, setOpen] = useState(defaultOpen);
  const [info, setInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const daily = hs.filter((h) => h.defaultOn);
  const others = hs.filter((h) => !h.defaultOn);
  const doneCount = daily.filter((h) => h.done).length;

  function tickHabit(slug: string, done: boolean) {
    setError(null);
    setHs((c) => c.map((h) => (h.slug === slug ? { ...h, done } : h)));
    start(async () => {
      const r = await setHabitDone(date, personId, slug, done);
      if (!r.ok) {
        setHs((c) => c.map((h) => (h.slug === slug ? { ...h, done: !done } : h)));
        setError(r.error);
      }
    });
  }

  return (
    <Card className="p-0">
      <button type="button" aria-expanded={open} aria-controls="basics-list" onClick={() => setOpen((o) => !o)}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-card px-4 text-left">
        <span className="text-lg font-semibold">Daily basics</span>
        <span className="flex items-center gap-2 text-sm text-muted tabular-nums">
          <span aria-live="polite">{doneCount} of {daily.length} done</span>
          <ChevronDownIcon className={`size-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      <div className="mx-4 h-1.5 overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${doneCount} of ${daily.length} daily basics done`}>
        <div className="h-full rounded-full bg-ok" style={{ width: `${daily.length ? (doneCount / daily.length) * 100 : 0}%` }} />
      </div>
      {open ? (
        <div id="basics-list" className="space-y-1 px-4 pb-3 pt-1">
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <ul className="divide-y divide-line">
            {daily.map((h) => (
              <li key={h.slug}>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 py-1.5">
                  <input type="checkbox" checked={h.done} onChange={(e) => tickHabit(h.slug, e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
                  <span className={h.done ? "text-muted line-through" : ""}>{h.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => setInfo(true)}>What the evidence says</Button>
        </div>
      ) : <div className="h-3" />}

      <Sheet open={info} onClose={() => setInfo(false)} title="Evidence for each habit">
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted">Each habit carries an honest grade, so traditional advice is not presented as science. This is general information, not medical advice.</p>
          <ul className="space-y-4">
            {[...daily, ...others].map((h) => (
              <li key={h.slug} className="border-b border-line pb-3">
                <p className="text-base font-semibold">{h.title}</p>
                <div className="my-1"><Pill tone={GRADE_TONE[h.grade]}>{GRADE_LABEL[h.grade]}</Pill></div>
                <p className="text-sm">{h.note}</p>
                {h.caution ? <p className="mt-1 text-sm font-semibold text-warn">{h.caution}</p> : null}
                {h.sourceUrl ? <a className="mt-1 inline-block min-h-11 py-2 text-sm font-semibold text-primary underline" href={h.sourceUrl} target="_blank" rel="noreferrer">Source</a> : null}
                {!h.defaultOn ? <SwitchRow checked={h.done} onChange={(v) => tickHabit(h.slug, v)} title="I did this today" /> : null}
              </li>
            ))}
          </ul>
        </div>
      </Sheet>
    </Card>
  );
}
