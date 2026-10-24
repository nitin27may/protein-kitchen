"use client";

import { useMemo, useRef, useState } from "react";
import { setPersonRoutine } from "@/app/actions";
import { RoutineCard } from "@/components/routines/RoutineCard";
import type { RoutineChange } from "@/components/routines/RoutineCard";
import { Banner } from "@/components/ui";
import type { PersonRoutineView, RoutineOption } from "@/lib/routines/types";
import { defaultsFor, groupByTime, MEDICAL_NOTE, normaliseDays, shouldGroup, sortRoutines } from "@/lib/routines/view";

type Saving = "idle" | "saving" | "saved";

/**
 * A person's routines. Each change is applied on screen at once and saved straight away; if the save fails the card
 * goes back to how it was and a banner says why. There is no Save button.
 */
export function RoutinePicker({ personId, personName, catalog, chosen }: { personId: number; personName: string; catalog: RoutineOption[]; chosen: PersonRoutineView[] }) {
  const [state, setState] = useState<Record<string, PersonRoutineView>>(() => {
    const byHabit = new Map(chosen.map((c) => [c.habitSlug, c]));
    return Object.fromEntries(
      catalog.map((o) => {
        const saved = byHabit.get(o.habitSlug);
        const d = defaultsFor(o);
        return [o.habitSlug, saved ? { ...saved, days: normaliseDays(saved.days) } : { habitSlug: o.habitSlug, active: false, days: d.days, timeOfDay: d.timeOfDay, servings: d.servings }];
      }),
    );
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>("idle");
  const [notice, setNotice] = useState<Record<string, string>>({});
  const inFlight = useRef(0);

  // Order is fixed from what was saved when the page opened, so cards do not jump while you switch them on.
  const ordered = useMemo(() => sortRoutines(catalog, chosen), [catalog, chosen]);
  const groups = useMemo(() => (shouldGroup(catalog.length) ? groupByTime(ordered) : null), [catalog.length, ordered]);

  async function apply(option: RoutineOption, next: RoutineChange) {
    const before = state[option.habitSlug]!;
    // Refuse to drop the last day: a routine on no day is the same as off.
    if (next.active && next.days.length === 0) {
      setNotice((n) => ({ ...n, [option.habitSlug]: "Pick at least one day, or turn the routine off." }));
      return;
    }
    setNotice((n) => ({ ...n, [option.habitSlug]: "" }));
    setError(null);
    setState((s) => ({ ...s, [option.habitSlug]: { ...before, ...next } }));
    inFlight.current += 1;
    setSaving("saving");
    const res = await setPersonRoutine(personId, option.habitSlug, { active: next.active, days: next.days, timeOfDay: next.timeOfDay, servings: next.servings });
    inFlight.current -= 1;
    if (!res.ok) {
      setState((s) => ({ ...s, [option.habitSlug]: before }));
      setError(res.error);
    }
    if (inFlight.current === 0) {
      setSaving(res.ok ? "saved" : "idle");
    }
  }

  const list = (options: RoutineOption[]) => (
    <ul className="grid items-start gap-3 lg:grid-cols-2">
      {options.map((o) => (
        <RoutineCard key={o.habitSlug} option={o} state={state[o.habitSlug]!} notice={notice[o.habitSlug] || null} onChange={(next) => void apply(o, next)} />
      ))}
    </ul>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{MEDICAL_NOTE}</p>
      <div aria-live="polite" role="status" className="min-h-5 text-sm text-muted">
        {saving === "saving" ? "Saving…" : saving === "saved" ? `Saved for ${personName}.` : ""}
      </div>
      {error ? <Banner tone="bad" title="Could not save">{error}</Banner> : null}
      {catalog.length === 0 ? <p className="text-sm text-muted">No routines are set up yet.</p> : null}
      {groups ? (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.time} aria-label={g.label}>
              <h3 className="mb-2 text-sm font-semibold text-muted">{g.label}</h3>
              {list(g.options)}
            </section>
          ))}
        </div>
      ) : (
        list(ordered)
      )}
    </div>
  );
}

