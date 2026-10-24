"use client";

import { Chip, ChoiceCard, SectionCard, Segmented } from "@/components/ui";
import type { MealType, TimeLimit } from "@/lib/plan/wizard";
import { MEALS, STYLE_OPTIONS, TIME_HINT } from "./constants";
import type { StepProps } from "./types";

/** Step 2: which meals to plan, how much to cook once and eat again, and how long cooking may take. */
export function MealsStep({ draft, setDraft, problems }: StepProps) {
  const mealsProblem = problems.find((p) => p.field === "meals");
  const toggle = (id: MealType) => setDraft({ meals: draft.meals.includes(id) ? draft.meals.filter((x) => x !== id) : [...draft.meals, id] });

  return (
    <div className="space-y-4">
      <SectionCard id="meals" title="Meals each day" description={draft.meals.includes("shake") ? "A shake is added every day, because you turned it on." : "A shake is only added when you turn it on."}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Meals to plan">
          {MEALS.map((m) => <Chip key={m.id} on={draft.meals.includes(m.id)} onClick={() => toggle(m.id)}>{m.label}</Chip>)}
        </div>
        {mealsProblem ? <p className="mt-2 text-sm text-bad" role="alert">{mealsProblem.message}</p> : null}
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard id="style" title="Cooking style" description="How much you want to cook once and eat again.">
          <div className="grid gap-2" role="radiogroup" aria-labelledby="style">
            {STYLE_OPTIONS.map(([v, label, hint]) => (
              <ChoiceCard key={v} type="radio" name="prepstyle" checked={draft.prepStyle === v} onChange={() => setDraft({ prepStyle: v })} title={label} hint={hint} />
            ))}
          </div>
        </SectionCard>

        <SectionCard id="time" title="Active cooking time" description="How long you are willing to stand at the stove for one meal.">
          <Segmented<TimeLimit> value={draft.timeLimit} onChange={(timeLimit) => setDraft({ timeLimit })} label="Active cooking time" options={[{ value: "weeknights", label: "Weeknights" }, { value: "always20", label: "Every day" }, { value: "none", label: "No limit" }]} className="w-full" />
          <p className="mt-2 text-sm text-muted">{TIME_HINT[draft.timeLimit]}</p>
        </SectionCard>
      </div>
    </div>
  );
}
