import { CheckIcon } from "@/components/icons";
import { Card, Pill, type Tone } from "@/components/ui";
import { eatenSummaryLine } from "@/lib/food-log/format";
import { MARKER_TEXT, type Marker, type ReviewCell, type ReviewSummary } from "@/lib/food-log/day-view";

export interface PlanEatenData {
  cells: ReviewCell[];
  summaries: ReviewSummary[];
}

const TONE: Partial<Record<Marker, Tone>> = { ate_plan: "ok", swapped: "info", skipped: "warn", partial: "warn", extras: "info" };

/** Planned and eaten protein for the shown day, a marker per person, and the plan's logged-days summary. */
export function PlanEatenCard({ day, data, showNames }: { day: string; data: PlanEatenData; showNames: boolean }) {
  const cells = data.cells.filter((c) => c.date === day);
  return (
    <Card className="space-y-3" >
      <h2 className="text-base font-semibold">Eaten against planned</h2>
      <ul className="space-y-3">
        {cells.map((c) => {
          const name = data.summaries.find((s) => s.personId === c.personId)?.name ?? "";
          const text = MARKER_TEXT[c.marker];
          return (
            <li key={c.personId} data-testid="eaten-day" className="space-y-1">
              {showNames ? <p className="text-sm text-muted">{name}</p> : null}
              <p className="text-sm tabular-nums">
                Planned <strong>{Math.round(c.plannedProteinG)} g</strong> protein
                {c.eatenProteinG === null ? <>, <span className="text-muted">not logged</span></> : <>, eaten <strong>{Math.round(c.eatenProteinG)} g</strong></>}
              </p>
              {text && c.eatenProteinG !== null ? (
                <Pill tone={TONE[c.marker] ?? "info"}>{c.marker === "ate_plan" ? <CheckIcon className="mr-1 size-3.5" /> : null}{text}</Pill>
              ) : text ? <p className="text-sm text-muted">{c.marker === "open" ? "Not yet" : "Not logged"}</p> : null}
            </li>
          );
        })}
      </ul>
      <div className="space-y-1 border-t border-line pt-3">
        {data.summaries.map((s) => (
          <p key={s.personId} className="text-sm" data-testid="eaten-summary">
            {showNames ? <span className="text-muted">{s.name}: </span> : null}
            {eatenSummaryLine({ loggedDays: s.loggedDays, totalDays: s.totalDays, averageG: s.averageG, targetG: s.targetG })}
          </p>
        ))}
      </div>
    </Card>
  );
}
