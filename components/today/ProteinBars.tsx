import { EatenProteinBar } from "@/components/foods-log/EatenProteinBar";
import { ProteinBar } from "@/components/ui";
import { showRoutineLine } from "@/lib/routines/schedule";

export interface PersonBar {
  id: number;
  name: string;
  proteinG: number;
  targetG: number;
  /** What the person's routines add that day, shown as its own muted line. Never part of the bar. */
  routines?: { proteinG: number; kcal: number } | null;
  /** When present the bar shows what was eaten (solid) and what is still planned (lighter) instead of the plan. */
  eaten?: { eatenG: number | null; pendingG: number };
}

/** Protein for the focus day, one compact bar per person, side by side when more than one eats. */
export function ProteinBars({ people, caption }: { people: PersonBar[]; caption: string }) {
  if (people.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-sm text-muted">{caption}</p>
      <div className={`grid gap-x-6 gap-y-3 ${people.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {people.map((p) => (
          <div key={p.id}>
            {p.eaten ? <EatenProteinBar label={p.name} eatenG={p.eaten.eatenG} pendingG={p.eaten.pendingG} targetG={p.targetG} /> : <ProteinBar value={p.proteinG} target={p.targetG} label={p.name} />}
            {showRoutineLine(p.routines) && p.routines ? (
              <p className="mt-1 text-sm text-muted">Routines add about {Math.round(p.routines.proteinG)} g protein and {Math.round(p.routines.kcal)} kcal.</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
