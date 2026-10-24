"use client";

import Link from "next/link";
import { Banner, Button, Pill, SectionCard } from "@/components/ui";
import { SLOT_LABEL } from "@/lib/format";
import type { FeasibilityResult } from "@/lib/planner/feasibility-types";
import { STEP_LABEL } from "@/lib/plan/wizard";
import type { WizardStep } from "@/lib/plan/wizard";
import type { FeasibilityState } from "./useFeasibility";
import type { DraftSummary } from "./summary";

const STATUS_WORD = { reachable: "Reachable", tight: "Tight", short: "Short" } as const;
const STATUS_TONE = { reachable: "ok", tight: "warn", short: "bad" } as const;

function Card({ step, title, onChange, children }: { step: WizardStep; title: string; onChange: (step: WizardStep) => void; children: React.ReactNode }) {
  return (
    <SectionCard id={`review-${step}`} title={title} action={<Button variant="secondary" size="sm" aria-label={`Change ${STEP_LABEL[step].toLowerCase()}`} onClick={() => onChange(step)}>Change</Button>}>
      {children}
    </SectionCard>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-3"><dt className="w-28 shrink-0 text-muted">{label}</dt><dd className="min-w-0 flex-1 font-medium">{children}</dd></div>;
}

/** Whether the planner can do what was asked: recipes left per meal type, and the protein each person can reach. */
export function FeasibilityPanel({ state, meals, onShake, canShake }: { state: FeasibilityState; meals: string[]; onShake: () => void; canShake: boolean }) {
  const r: FeasibilityResult | null = state.result;
  return (
    <section aria-labelledby="feas-h" aria-live="polite" aria-busy={state.status === "loading"} className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="feas-h" className="text-lg font-semibold">Will this plan work?</h2>
        {state.status === "loading" ? <span className="text-sm text-muted">Checking</span> : null}
      </div>
      {state.status === "error" ? <div className="mt-3"><Banner tone="warn" title="Could not check this plan">{state.message} You can still generate it.</Banner></div> : null}
      {!r && state.status !== "error" ? <p className="mt-3 text-sm text-muted">{state.status === "idle" ? "Complete the first two steps to see what the planner can do." : "Checking what the planner can do with your choices."}</p> : null}
      {r ? (
        <div className="mt-3 space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Recipes that fit</h3>
            <ul className="mt-1 divide-y divide-line">
              {r.slots.filter((s) => meals.includes(s.slot)).map((s) => (
                <li key={s.slot} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{SLOT_LABEL[s.slot] ?? s.slot}: <strong>{s.eligible}</strong> of {s.total} recipes</span>
                  <Pill tone={s.eligible === 0 ? "bad" : s.eligible < 3 ? "warn" : "ok"}>{s.eligible === 0 ? "None fit" : s.eligible < 3 ? "Few options" : "Plenty"}</Pill>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Protein</h3>
            <ul className="mt-1 divide-y divide-line">
              {r.people.map((p) => (
                <li key={p.personId} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span>{p.name} can reach about <strong>{Math.round(p.typicalG)} to {Math.round(p.bestG)} g</strong> of their {Math.round(p.targetG)} g target.</span>
                  <Pill tone={STATUS_TONE[p.status]}>{STATUS_WORD[p.status]}</Pill>
                </li>
              ))}
            </ul>
          </div>
          {r.notes.length ? (
            <ul className="space-y-1 text-sm text-muted">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          ) : null}
          {canShake ? (
            <div className="rounded-control bg-primarysoft p-3">
              <p className="text-sm">A daily shake would close the gap.</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={onShake}>Turn on a shake</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The last step: one card per step with Change, then the feasibility check and the one action. */
export function ReviewStep({ summary, onChange, state, meals, repeat, onShake, canShake, blockers, onGenerate, pending, error }: {
  summary: DraftSummary;
  onChange: (step: WizardStep) => void;
  state: FeasibilityState;
  meals: string[];
  repeat: boolean;
  onShake: () => void;
  canShake: boolean;
  blockers: string[];
  onGenerate: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
      <div className="space-y-4">
        {error ? <Banner tone="bad" title="Could not make the plan">{error}</Banner> : null}
        {repeat ? <Banner tone="info" title="Same as last time">This is the setup from your last plan. Generate it as it is, or change any card.</Banner> : null}

        <Card step="who" title="Who and when" onChange={onChange}>
          <dl className="space-y-1.5 text-sm">
            <Row label="Eating">{summary.eating}</Row>
            <Row label="Dates"><span className="tabular-nums">{summary.range}</span>, {summary.dayCount} {summary.dayCount === 1 ? "day" : "days"}</Row>
            <Row label="Shop and prep">{summary.days}</Row>
          </dl>
        </Card>
        <Card step="meals" title="Meals and effort" onChange={onChange}>
          <dl className="space-y-1.5 text-sm">
            <Row label="Meals">{summary.meals}</Row>
            <Row label="Style">{summary.style}</Row>
            <Row label="Cooking time">{summary.timeLimit}</Row>
          </dl>
        </Card>
        <Card step="food" title="Food" onChange={onChange}>
          <dl className="space-y-1.5 text-sm">
            <Row label="Likes">{summary.likes}</Row>
            <Row label="Avoids">{summary.avoids}</Row>
            <Row label="Cuisine">{summary.cuisine}</Row>
            <Row label="Focus">{summary.focus}</Row>
            <Row label="Pinned">{summary.pinned}</Row>
          </dl>
        </Card>
        <Card step="routine" title="Daily routine" onChange={onChange}>
          <p className="text-sm">Routines you turned on for each person are included in this plan. <Link href="/profiles" className="font-semibold text-primary underline-offset-2 hover:underline">Manage on profiles</Link></p>
        </Card>
      </div>

      <div className="mt-4 space-y-4 lg:sticky lg:top-4 lg:mt-0">
        <FeasibilityPanel state={state} meals={meals} onShake={onShake} canShake={canShake} />
        <div className="hidden lg:block">
          {blockers.length ? <p className="mb-2 text-sm text-bad" role="alert">{blockers[0]}</p> : null}
          <Button size="lg" className="w-full" onClick={onGenerate} loading={pending} disabled={blockers.length > 0}>{pending ? "Planning" : "Generate plan"}</Button>
          <p className="mt-2 text-center text-xs text-muted">You can swap or lock any meal afterwards.</p>
        </div>
      </div>
    </div>
  );
}
