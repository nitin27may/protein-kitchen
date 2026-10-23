"use client";

import { useMemo, useState, useTransition } from "react";
import { setPartMode } from "@/app/actions";
import { PartCard } from "@/components/parts/PartCard";
import { Banner, Pill } from "@/components/ui";
import type { PartMode, PartModes } from "@/lib/parts/mode";
import { buildTimeline } from "@/lib/recipes/timeline";
import type { PartAdvance, PartView } from "@/lib/recipes/timeline";

/**
 * "Parts of this meal": a timeline, then one card per part with a Make / Buy / Have switch.
 * With a plan (`planId`) the choice is saved for that plan and used by its grocery list and prep guide.
 * Without one it is a preview that is not saved.
 */
export function PartsSection({ parts, initialModes, planId, factor, makeAheadMin, mealAdvancePrep }: { parts: PartView[]; initialModes: PartModes; planId: number | null; factor: number; makeAheadMin: number; mealAdvancePrep: PartAdvance[] }) {
  const [modes, setModes] = useState<PartModes>(initialModes);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const timeline = useMemo(() => buildTimeline(parts, modes, { mealAdvancePrep, finalStep: "put it together" }), [parts, modes, mealAdvancePrep]);

  function change(slug: string, mode: PartMode) {
    setError(null);
    if (planId === null) {
      setModes((m) => ({ ...m, [slug]: mode }));
      return;
    }
    const before = modes;
    setModes((m) => ({ ...m, [slug]: mode }));
    start(async () => {
      const r = await setPartMode(planId, slug, mode);
      if (!r.ok) {
        setModes(before);
        setError(r.error);
      }
    });
  }

  return (
    <section aria-labelledby="parts-h" className="rounded-card border border-line bg-surface p-4 lg:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="parts-h" className="text-lg font-semibold leading-snug">Parts of this meal</h2>
          <p className="mt-0.5 text-sm text-muted">Each part has its own method. Choose whether you make it, buy it, or already have it.</p>
        </div>
        {makeAheadMin > 0 ? <Pill tone="ok">Make ahead saves {makeAheadMin} min on the day</Pill> : null}
      </div>

      <ol className="mt-4 space-y-1.5 rounded-control bg-surface2 p-3 text-sm" aria-label="When to do what" aria-live="polite">
        {timeline.map((l) => (
          <li key={l.when} className="flex gap-2"><span className="w-40 shrink-0 font-semibold sm:w-48">{l.when}</span><span>{l.what}</span></li>
        ))}
      </ol>

      {planId === null ? <p className="mt-3 text-sm text-muted">Open this recipe from a plan to save your choice.</p> : null}
      {error ? <div className="mt-3"><Banner tone="bad">{error}</Banner></div> : null}

      <ul className="mt-4 space-y-3">
        {parts.map((p) => <PartCard key={p.slug} part={p} modes={modes} factor={factor} onMode={change} busy={pending} />)}
      </ul>
    </section>
  );
}
