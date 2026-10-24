"use client";

import { PlusIcon } from "@/components/icons";
import { Chip, Field, Input, SectionCard, Segmented, Select } from "@/components/ui";
import { addDays } from "@/lib/planner/dates";
import { dateProblem, draftDayCount, draftEnd } from "@/lib/plan/wizard";
import type { PlanLength } from "@/lib/plan/wizard";
import { ALL_DAYS } from "@/lib/routines/types";
import type { IsoWeekday } from "@/lib/routines/types";
import { fmtRange, WEEKDAY_NAME } from "./constants";
import type { StepProps } from "./types";

const dayOption = (value: string): IsoWeekday | null => (value === "" ? null : (Number(value) as IsoWeekday));

/** Step 1: who is eating, which days the plan covers, and (optionally) when you shop and when you prep. */
export function WhoStep({ draft, setDraft, people, problems }: StepProps) {
  const end = draftEnd(draft);
  const dayCount = draftDayCount(draft);
  const dates = dateProblem(draft);
  const peopleProblem = problems.find((p) => p.field === "people");
  const selected = people.filter((p) => draft.personIds.includes(p.id));
  const toggle = (id: number) => setDraft({ personIds: draft.personIds.includes(id) ? draft.personIds.filter((x) => x !== id) : [...draft.personIds, id] });

  return (
    <div className="space-y-4">
      <SectionCard id="who" title="Who is eating" description="Protein targets come from each profile.">
        <div className="flex flex-wrap gap-2" role="group" aria-label="People">
          {people.map((p) => <Chip key={p.id} on={draft.personIds.includes(p.id)} onClick={() => toggle(p.id)}>{p.name}</Chip>)}
          <a href="/profiles/new?next=/plan/new" className="inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-strong px-3.5 text-sm font-semibold text-primary hover:bg-primarysoft lg:min-h-9"><PlusIcon className="size-4" />Add person</a>
        </div>
        {peopleProblem ? <p className="mt-2 text-sm text-bad" role="alert">{peopleProblem.message}</p> : null}
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {selected.map((p) => (
            <li key={p.id}><strong className="text-fg">{p.name}</strong>: {p.proteinTarget} g protein{p.kcalTarget ? `, ${p.kcalTarget} kcal` : ""} a day. <a className="inline-flex min-h-11 items-center px-1 font-semibold text-primary underline-offset-2 hover:underline" href={`/profiles/${p.id}`}>Edit</a></li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard id="len" title="When" description="Plans start on a Monday by default.">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <Segmented<PlanLength> value={draft.length} onChange={(length) => setDraft({ length, ...(length === "custom" ? { customEnd: addDays(draft.start, 2) } : {}) })} label="Plan length" options={[{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "custom", label: "Custom" }]} />
          <Field label="Start" htmlFor="start"><Input id="start" type="date" value={draft.start} onChange={(e) => setDraft({ start: e.target.value })} className="w-44" /></Field>
          <Field label="End" htmlFor="end"><Input id="end" type="date" value={end} disabled={draft.length !== "custom"} onChange={(e) => setDraft({ customEnd: e.target.value })} className="w-44" /></Field>
        </div>
        <p className={`mt-3 text-sm ${dates ? "text-bad" : "text-muted"}`} role={dates ? "alert" : undefined}>
          {dates ?? <>{fmtRange(draft.start, end)}, <strong className="text-fg">{dayCount} {dayCount === 1 ? "day" : "days"}</strong>.{dayCount > 14 ? " Long plans make a long grocery list; you can shop week by week from it." : ""}</>}
        </p>
      </SectionCard>

      <SectionCard id="days" title="Shopping and prep days" description="Optional. They only change when Today tells you to shop and to prepare.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shopping day" htmlFor="shopping-day" hint="Sets the shop-by date on Today.">
            <Select id="shopping-day" value={draft.shoppingDay ?? ""} onChange={(e) => setDraft({ shoppingDay: dayOption(e.target.value) })}>
              <option value="">No preference</option>
              {ALL_DAYS.map((d) => <option key={d} value={d}>{WEEKDAY_NAME[d]}</option>)}
            </Select>
          </Field>
          <Field label="Prep day" htmlFor="prep-day" hint="The day you do batch cooking.">
            <Select id="prep-day" value={draft.prepDay ?? ""} onChange={(e) => setDraft({ prepDay: dayOption(e.target.value) })}>
              <option value="">No preference</option>
              {ALL_DAYS.map((d) => <option key={d} value={d}>{WEEKDAY_NAME[d]}</option>)}
            </Select>
          </Field>
        </div>
      </SectionCard>
    </div>
  );
}
