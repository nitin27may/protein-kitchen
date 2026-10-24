"use client";

import { Chip, SwitchRow, Button } from "@/components/ui";
import { CautionNote } from "@/components/routines/CautionNote";
import { EvidenceBadge } from "@/components/routines/EvidenceBadge";
import { servingsLabel } from "@/lib/format";
import { ALL_DAYS, DAY_LABEL, TIMES_OF_DAY, TIME_OF_DAY_LABEL } from "@/lib/routines/types";
import type { IsoWeekday, PersonRoutineView, RoutineOption, TimeOfDay } from "@/lib/routines/types";
import { everyDay, isEveryDay, isWeekdays, SERVINGS_MAX, SERVINGS_MIN, soakLine, stepServings, summaryLine, toggleDay, weekdays } from "@/lib/routines/view";

export type RoutineChange = { active: boolean; days: IsoWeekday[]; timeOfDay: TimeOfDay; servings: number };

/** One routine a person can choose. Every control reports a full new state; the picker saves it straight away. */
export function RoutineCard({ option, state, onChange, notice }: { option: RoutineOption; state: PersonRoutineView; onChange: (next: RoutineChange) => void; notice?: string | null }) {
  const on = state.active;
  const send = (patch: Partial<RoutineChange>) => onChange({ active: state.active, days: state.days, timeOfDay: state.timeOfDay, servings: state.servings, ...patch });
  const soak = soakLine(option);
  const summary = summaryLine(option);
  const headingId = `routine-${option.habitSlug}`;

  return (
    <li className={`rounded-card border bg-surface p-4 ${on ? "border-primary/60" : "border-line"}`} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold leading-snug">{option.title}</h3>
        <span className="text-sm text-muted">{TIME_OF_DAY_LABEL[option.timeOfDay]}</span>
      </div>
      <div className="mt-1"><EvidenceBadge grade={option.grade} /></div>
      <p className="mt-2 text-sm">{option.evidenceNote}</p>
      {summary || soak ? (
        <p className="mt-2 text-sm text-muted">
          {summary}
          {summary && soak ? " " : ""}
          {soak ? <strong className="font-semibold text-fg">{soak}.</strong> : null}
        </p>
      ) : null}
      {option.items.length ? (
        <p className="mt-1 text-sm text-muted tabular-nums">Per serving: {option.items.map((i) => `${i.name} ${i.grams} g`).join(", ")}.</p>
      ) : null}
      {option.caution ? <div className="mt-3"><CautionNote caution={option.caution} /></div> : null}

      <div className="mt-2 border-t border-line">
        <SwitchRow checked={on} onChange={(v) => send({ active: v })} title="Do this routine" hint={on ? "Saved for this person. New plans will include it." : undefined} />
      </div>

      {on ? (
        <div className="space-y-4 border-t border-line pt-3">
          <div>
            <p className="mb-1 text-sm font-semibold" id={`${headingId}-days`}>Days</p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${headingId}-days`}>
              <Chip on={isEveryDay(state.days)} onClick={() => send({ days: everyDay() })}>Every day</Chip>
              <Chip on={isWeekdays(state.days)} onClick={() => send({ days: weekdays() })}>Weekdays</Chip>
            </div>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Days for ${option.title}`}>
              {ALL_DAYS.map((d) => (
                <Chip key={d} on={state.days.includes(d)} onClick={() => send({ days: toggleDay(state.days, d) })} label={DAY_LABEL[d]}>{DAY_LABEL[d]}</Chip>
              ))}
            </div>
            {notice ? <p className="mt-1 text-sm text-muted" role="status">{notice}</p> : null}
          </div>

          <div>
            <p className="mb-1 text-sm font-semibold">Time of day</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Time of day for ${option.title}`}>
              {TIMES_OF_DAY.map((t) => (
                <Chip key={t} on={state.timeOfDay === t} onClick={() => send({ timeOfDay: t })}>{TIME_OF_DAY_LABEL[t]}</Chip>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-sm font-semibold">Servings</p>
            <div className="inline-flex items-center gap-3">
              <Button variant="secondary" size="sm" aria-label={`Fewer servings of ${option.title}`} disabled={state.servings <= SERVINGS_MIN} onClick={() => send({ servings: stepServings(state.servings, -1) })}>−</Button>
              <span className="min-w-8 text-center text-lg font-semibold tabular-nums" aria-live="polite">{servingsLabel(state.servings)}</span>
              <Button variant="secondary" size="sm" aria-label={`More servings of ${option.title}`} disabled={state.servings >= SERVINGS_MAX} onClick={() => send({ servings: stepServings(state.servings, 1) })}>+</Button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
