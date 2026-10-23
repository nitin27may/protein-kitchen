import { ProteinBar } from "@/components/ui";

export interface PersonBar {
  id: number;
  name: string;
  proteinG: number;
  targetG: number;
}

/** Planned protein for the focus day, one compact bar per person, side by side when more than one eats. */
export function ProteinBars({ people, caption }: { people: PersonBar[]; caption: string }) {
  if (people.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-sm text-muted">{caption}</p>
      <div className={`grid gap-x-6 gap-y-3 ${people.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {people.map((p) => <ProteinBar key={p.id} value={p.proteinG} target={p.targetG} label={p.name} />)}
      </div>
    </div>
  );
}
