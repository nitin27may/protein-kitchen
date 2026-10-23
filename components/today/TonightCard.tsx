"use client";

import { useState, useTransition } from "react";
import { setPrepDone } from "@/app/actions";
import { Banner, Card } from "@/components/ui";
import { formatDay } from "@/lib/planner/dates";
import type { PrepView } from "./types";

/**
 * Night-before prep. Overdue tasks (due earlier, still not ticked, food not cooked yet) come first so a plan made late
 * does not hide its first soak. With nothing to do, this is one muted line, not an empty card.
 */
export function TonightCard({ tonight, overdue, preview, today }: { tonight: PrepView[]; overdue: PrepView[]; preview?: { label: string; name: string } | null; today: string }) {
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries([...overdue, ...tonight].map((t) => [t.key, t.done])));
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  function tick(t: PrepView, done: boolean) {
    setError(null);
    setState((c) => ({ ...c, [t.key]: done }));
    start(async () => {
      const r = await setPrepDone(t.dueDate, t.key, done);
      if (!r.ok) {
        setState((c) => ({ ...c, [t.key]: !done }));
        setError(r.error);
      }
    });
  }

  if (tonight.length === 0 && overdue.length === 0) {
    return <p className="px-1 text-sm text-muted">Nothing to prep tonight.{preview ? ` Tomorrow starts with ${preview.label.toLowerCase()}: ${preview.name}.` : ""}</p>;
  }

  const list = (items: PrepView[], withDay: boolean) => (
    <ul className="divide-y divide-line">
      {items.map((t) => (
        <li key={t.key}>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 py-1.5">
            <input type="checkbox" checked={state[t.key] ?? t.done} onChange={(e) => tick(t, e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
            <span className={(state[t.key] ?? t.done) ? "text-muted line-through" : ""}>
              {t.text}, for {t.forName}
              {withDay ? <span className="block text-sm text-bad">Was due {t.dueDate === today ? "today" : formatDay(t.dueDate).long}</span> : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );

  const open = [...overdue, ...tonight].filter((t) => !(state[t.key] ?? t.done)).length;

  return (
    <Card className="space-y-2">
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="tonight" className="text-lg font-semibold">Tonight: prep for tomorrow</h2>
        <span className="text-sm text-muted tabular-nums" aria-live="polite">{open === 0 ? "All done" : `${open} to do`}</span>
      </div>
      {overdue.length ? (
        <div>
          <h3 className="text-sm font-semibold text-bad">Overdue</h3>
          {list(overdue, true)}
        </div>
      ) : null}
      {tonight.length ? list(tonight, false) : null}
      {preview ? <p className="border-t border-line pt-2 text-sm text-muted">Tomorrow starts with {preview.label.toLowerCase()}: <span className="font-semibold text-fg">{preview.name}</span>.</p> : null}
    </Card>
  );
}
