import type { ReactNode } from "react";
import { Card, LinkButton } from "@/components/ui";
import { formatDay } from "@/lib/planner/dates";
import type { PlanPhase } from "@/lib/plan/phase";

export interface SetupSummary {
  days: number;
  mealTypes: string[];
  people: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const describe = (s: SetupSummary) => `${plural(s.days, "day")}, ${s.mealTypes.join(", ")}, ${plural(s.people, "person", "people")}`;

/** The one card that says where you are in the plan and what the next step is. */
export function PhaseCard({ phase, setup, children }: { phase: PlanPhase; setup?: SetupSummary | undefined; children?: ReactNode }) {
  if (phase.kind === "no-plan") {
    const ended = phase.reason === "ended";
    return (
      <Card className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold leading-tight">{ended ? "Plan next week" : "Plan your week"}</h2>
          <p className="mt-1 text-muted">
            {ended && phase.endedOn ? `Your last plan ended ${formatDay(phase.endedOn).long}.` : "Choose days, meals and what you like. Meals, groceries and prep follow from that."}
            {setup ? ` Last time: ${describe(setup)}.` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/plan/new" size="lg">{setup ? "Same as last time" : "Make a plan"}</LinkButton>
          {setup ? <LinkButton href="/plan/new#who" variant="secondary" size="lg">Change</LinkButton> : null}
        </div>
      </Card>
    );
  }

  if (phase.kind === "starts-later") {
    const soon = phase.daysUntilStart === 1;
    return (
      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <p className="font-display text-6xl font-bold leading-none tabular-nums">{phase.daysUntilStart}</p>
            <p className="mt-1 text-sm text-muted">{soon ? "day to go" : "days to go"}</p>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold leading-snug">{soon ? "Your plan starts tomorrow" : `Your plan starts ${formatDay(phase.startDate).long}`}</h2>
            <p className="text-muted">Shop and prep before day 1.</p>
          </div>
        </div>
        {phase.firstTask ? (
          <p className="rounded-control bg-surface2 p-3 text-sm">
            <span className="font-semibold">First prep, {formatDay(phase.firstTask.dueDate).long} evening: </span>
            {phase.firstTask.text}, for {phase.firstTask.forName}.
          </p>
        ) : null}
        {children}
      </Card>
    );
  }

  const last = phase.kind === "last-two-days";
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold leading-snug">Day {phase.dayNumber} of {phase.totalDays}</h2>
        <p className="text-sm text-muted">Plan runs to {formatDay(phase.endDate).long}</p>
      </div>
      {children}
      {last ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-accent/40 bg-accentsoft p-3">
          <p className="text-sm font-semibold">{phase.daysLeft === 0 ? "Your plan ends today." : `Your plan ends ${formatDay(phase.endDate).long}.`} Plan next week.</p>
          <LinkButton href="/plan/new" size="sm">Plan next week</LinkButton>
        </div>
      ) : null}
    </Card>
  );
}
