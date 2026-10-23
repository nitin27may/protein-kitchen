"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setHabitDone, setPrepDone } from "@/app/actions";
import { Sheet } from "@/components/Sheet";
import { Banner, Button, Card, Chip, MacroLine, Pill, SwitchRow } from "@/components/ui";
import type { Tone } from "@/components/ui";

export interface HabitView {
  slug: string;
  title: string;
  grade: "strong" | "moderate" | "weak" | "myth" | "practical";
  note: string;
  caution: string | null;
  sourceUrl: string | null;
  done: boolean;
  defaultOn: boolean;
}

export interface PrepView {
  key: string;
  text: string;
  done: boolean;
}

export interface SnackView {
  slug: string;
  name: string;
  proteinG: number;
  kcal: number;
  minutes: number;
  needsCooking: boolean;
}

const GRADE_TONE: Record<HabitView["grade"], Tone> = { strong: "ok", moderate: "info", practical: "info", weak: "warn", myth: "bad" };
const GRADE_LABEL: Record<HabitView["grade"], string> = {
  strong: "Strong evidence",
  moderate: "Some evidence",
  practical: "Practical, no health claim",
  weak: "Weak evidence",
  myth: "Myth",
};

export function TodayCard({
  date,
  dateLabel,
  personId,
  personName,
  habits,
  prep,
  prepDate,
  snacks,
}: {
  date: string;
  dateLabel: string;
  personId: number;
  personName: string;
  habits: HabitView[];
  prep: PrepView[];
  prepDate: string;
  snacks: Record<"0" | "5" | "10", SnackView[]>;
}) {
  const [hs, setHs] = useState(habits);
  const [ps, setPs] = useState(prep);
  const [info, setInfo] = useState(false);
  const [snackOpen, setSnackOpen] = useState(false);
  const [bucket, setBucket] = useState<"0" | "5" | "10">("5");
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const daily = hs.filter((h) => h.defaultOn);
  const others = hs.filter((h) => !h.defaultOn);

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

  function tickPrep(key: string, done: boolean) {
    setError(null);
    setPs((c) => c.map((t) => (t.key === key ? { ...t, done } : t)));
    start(async () => {
      const r = await setPrepDone(prepDate, key, done);
      if (!r.ok) {
        setPs((c) => c.map((t) => (t.key === key ? { ...t, done: !done } : t)));
        setError(r.error);
      }
    });
  }

  const doneCount = daily.filter((h) => h.done).length;

  return (
    <div className="space-y-4">
      {error ? <Banner tone="bad">{error}</Banner> : null}

      <Card className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="basics" className="text-lg font-semibold">Daily basics</h2>
          <span className="text-sm text-muted tabular-nums" aria-live="polite">{doneCount} of {daily.length} done</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${doneCount} of ${daily.length} daily basics done`}>
          <div className="h-full rounded-full bg-ok" style={{ width: `${daily.length ? (doneCount / daily.length) * 100 : 0}%` }} />
        </div>
        <ul className="divide-y divide-line pt-1">
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
      </Card>

      <Card className="space-y-1">
        <h2 id="tonight" className="text-lg font-semibold">Tonight: prep for tomorrow</h2>
        {ps.length === 0 ? (
          <p className="text-sm text-muted">Nothing to prepare for tomorrow's meals.</p>
        ) : (
          <ul className="divide-y divide-line">
            {ps.map((t) => (
              <li key={t.key}>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 py-1.5">
                  <input type="checkbox" checked={t.done} onChange={(e) => tickPrep(t.key, e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
                  <span className={t.done ? "text-muted line-through" : ""}>{t.text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Button size="lg" className="w-full" onClick={() => setSnackOpen(true)}>Snack now</Button>

      <Sheet open={snackOpen} onClose={() => setSnackOpen(false)} title="Snack now">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Time available">
            {(["0", "5", "10"] as const).map((b) => (
              <Chip key={b} on={bucket === b} onClick={() => setBucket(b)}>{b === "0" ? "No cooking" : `${b} min`}</Chip>
            ))}
          </div>
          <p className="text-sm text-muted">Ideas only. Picking one does not change your plan or log anything.</p>
          <ul className="space-y-2">
            {snacks[bucket].length === 0 ? <li className="rounded-card border border-dashed border-line p-4 text-center text-muted">No snack of 10 g protein or more fits that time yet.</li> : null}
            {snacks[bucket].map((s) => (
              <li key={s.slug} className="rounded-card border border-strong p-3">
                <Link href={`/recipes/${s.slug}`} className="text-base font-semibold hover:underline">{s.name}</Link>
                <MacroLine protein={s.proteinG} kcal={s.kcal} minutes={s.minutes} />
                <Pill tone={s.needsCooking ? "warn" : "ok"}>{s.needsCooking ? "Needs cooking" : "No cooking"}</Pill>
              </li>
            ))}
          </ul>
        </div>
      </Sheet>

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
    </div>
  );
}
