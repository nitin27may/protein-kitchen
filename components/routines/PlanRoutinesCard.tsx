import Link from "next/link";
import { Card } from "@/components/ui";
import { servingsLabel } from "@/lib/format";
import { ALL_DAYS, DAY_LABEL } from "@/lib/routines/types";
import type { PlanRoutineRow } from "@/lib/routines/view";

/** Read-only: the routines a plan was made with, per person. A plan keeps its own copy, so later profile changes apply to new plans. */
export function PlanRoutinesCard({ rows, people }: { rows: PlanRoutineRow[]; people: { id: number; name: string }[] }) {
  const firstId = people[0]?.id;
  const link = (id: number | undefined) => (id ? `/profiles/${id}#daily-routine` : "/profiles");
  if (rows.length === 0) {
    return (
      <Card>
        <h2 className="text-base font-semibold">Routines in this plan</h2>
        <p className="mt-1 text-sm text-muted">
          No daily routines in this plan. <Link href={link(firstId)} className="font-semibold text-primary underline-offset-2 hover:underline">Add them on a profile.</Link>
        </p>
      </Card>
    );
  }
  const shown = people.filter((p) => rows.some((r) => r.personId === p.id));
  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold">Routines in this plan</h2>
      {shown.map((person) => (
        <section key={person.id} aria-label={`${person.name}'s routines`}>
          {people.length > 1 ? <h3 className="mb-1 text-sm font-semibold text-muted">{person.name}</h3> : null}
          <ul className="divide-y divide-line">
            {rows.filter((r) => r.personId === person.id).map((r) => (
              <li key={`${r.personId}-${r.habitSlug}`} className="py-2">
                <p className="font-semibold leading-snug">{r.title}</p>
                <p className="text-sm text-muted">
                  {r.timeLabel}, {r.daysPhrase}, {servingsLabel(r.servings)} {r.servings === 1 ? "serving" : "servings"}
                  {r.soak ? <> · <strong className="font-semibold text-fg">Soak the night before</strong></> : null}
                </p>
                <div className="mt-1 flex flex-wrap gap-1" aria-label={`Days: ${r.daysLabel}`} role="group">
                  {ALL_DAYS.map((d) => (
                    <span key={d} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${r.days.includes(d) ? "border-primary bg-primarysoft text-primary" : "border-line text-muted"}`}>{DAY_LABEL[d]}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <Link href={link(person.id)} className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-2 hover:underline lg:min-h-9">Change routines for {person.name}</Link>
        </section>
      ))}
      <p className="text-sm text-muted">A plan keeps the routines it was made with. Changes on a profile apply to plans made from now on.</p>
    </Card>
  );
}
