"use client";

import { Button } from "@/components/ui";
import type { DraftSummary } from "./summary";

/** The plan as it stands, beside steps 1 to 4 on wide screens. The review step replaces it with the full cards. */
export function SummaryPanel({ summary, onReview }: { summary: DraftSummary; onReview: () => void }) {
  return (
    <aside aria-label="Plan summary" className="hidden lg:sticky lg:top-4 lg:block">
      <div className="rounded-card border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Your plan</h2>
        <div className="mt-3 flex items-end gap-6">
          <div><p className="font-display text-5xl font-bold tabular-nums leading-none">{summary.dayCount > 0 ? summary.dayCount : 0}</p><p className="mt-1 text-sm text-muted">{summary.dayCount === 1 ? "day" : "days"}</p></div>
          <div><p className="font-display text-5xl font-bold tabular-nums leading-none text-accent">{summary.mealCount}</p><p className="mt-1 text-sm text-muted">meals</p></div>
        </div>
        <p className="mt-2 text-sm text-muted">{summary.range}</p>
        <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
          <div><dt className="text-muted">Eating</dt><dd className="font-medium">{summary.eating}</dd></div>
          <div><dt className="text-muted">Meals</dt><dd className="font-medium">{summary.meals}</dd></div>
          <div><dt className="text-muted">Style</dt><dd className="font-medium">{summary.style}</dd></div>
          <div><dt className="text-muted">Likes</dt><dd className="font-medium">{summary.likes}</dd></div>
          <div><dt className="text-muted">Avoids</dt><dd className="font-medium">{summary.avoids}</dd></div>
          <div><dt className="text-muted">Focus</dt><dd className="font-medium">{summary.focus}</dd></div>
        </dl>
        <Button variant="secondary" className="mt-4 w-full" onClick={onReview}>Go to review</Button>
        <p className="mt-2 text-center text-xs text-muted">You generate the plan from the review step.</p>
      </div>
    </aside>
  );
}
