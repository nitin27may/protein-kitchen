"use client";

import { useState } from "react";
import { RoutinePicker } from "@/components/routines/RoutinePicker";
import { Banner, SectionCard, Segmented } from "@/components/ui";
import type { PersonRoutineView, RoutineOption } from "@/lib/routines/types";
import type { StepProps } from "./types";

/**
 * Step 4: daily routines for each person who is eating. Choices save to the profile at once, so there is nothing to
 * submit here. The plan takes a copy of them when it is generated.
 */
export function RoutineStep({ draft, people, catalog, chosen }: StepProps & { catalog: RoutineOption[]; chosen: Record<number, PersonRoutineView[]> }) {
  const selected = people.filter((p) => draft.personIds.includes(p.id));
  const [whoRaw, setWho] = useState<number>(selected[0]?.id ?? 0);
  const who = selected.find((p) => p.id === whoRaw) ?? selected[0];

  if (!who) return <Banner tone="warn">Choose who is eating on the first step to set their routines.</Banner>;

  return (
    <SectionCard id="routines" title="Daily routine" description="Drinks and small habits on a schedule, such as methi water. They add their ingredients to the groceries and their soaking to the night before. Skip this step to leave them as they are.">
      <p className="mb-3 rounded-control bg-primarysoft p-3 text-sm font-medium text-primary">Routines you turn on are included in this plan.</p>
      {selected.length > 1 ? (
        <div className="mb-4">
          <Segmented<string> value={String(who.id)} onChange={(v) => setWho(Number(v))} label="Whose routines" options={selected.map((p) => ({ value: String(p.id), label: p.name }))} />
        </div>
      ) : null}
      {/* Keyed by person so each person's picker keeps its own state. */}
      <RoutinePicker key={who.id} personId={who.id} personName={who.name} catalog={catalog} chosen={chosen[who.id] ?? []} />
    </SectionCard>
  );
}
