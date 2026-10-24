"use client";

import { useMemo, useState } from "react";
import { IngredientPicker, nextState, PrefChip, stateOf } from "@/components/IngredientPicker";
import type { PickerIngredient, PrefSet } from "@/components/IngredientPicker";
import { Button, SectionCard, SwitchRow } from "@/components/ui";
import { PinSheet } from "./PinSheet";
import type { PinRecipe, StepProps } from "./types";

/** Step 3: what you like and avoid, how Indian the mix is, the healthy focus, and any recipes you want pinned. */
export function FoodStep({ draft, setDraft, people, ingredients, anchors, recipes }: StepProps & { ingredients: PickerIngredient[]; anchors: { slug: string; label: string }[]; recipes: PinRecipe[] }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);

  const selected = people.filter((p) => draft.personIds.includes(p.id));
  const anchorPeople = selected.length ? selected : people.slice(0, 1);
  const firstId = anchorPeople[0]?.id ?? 0;
  const prefs = draft.prefs;
  const nameOf = useMemo(() => new Map(ingredients.map((i) => [i.slug, i.name])), [ingredients]);

  /** The staple chips act on every selected person at once, so one tap covers the household. */
  function cycleAnchor(slug: string) {
    const base = prefs[firstId] ?? { liked: [], avoided: [] };
    const target = nextState(base, slug);
    const next = { ...prefs };
    for (const p of anchorPeople) {
      const prev = next[p.id] ?? { liked: [], avoided: [] };
      const liked = prev.liked.filter((s) => s !== slug);
      const avoided = prev.avoided.filter((s) => s !== slug);
      if (target.liked.includes(slug)) liked.push(slug);
      if (target.avoided.includes(slug)) avoided.push(slug);
      next[p.id] = { liked, avoided };
    }
    setDraft({ prefs: next });
  }

  const totalLiked = new Set(anchorPeople.flatMap((p) => prefs[p.id]?.liked ?? [])).size;
  const totalAvoided = new Set(anchorPeople.flatMap((p) => prefs[p.id]?.avoided ?? [])).size;
  const extraLiked = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.liked ?? []))].filter((s) => !anchors.some((a) => a.slug === s));
  const extraAvoided = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.avoided ?? []))].filter((s) => !anchors.some((a) => a.slug === s));
  const pinnedNames = draft.pinned.map((sl) => recipes.find((r) => r.slug === sl)?.name ?? sl);

  return (
    <div className="space-y-4">
      <SectionCard id="likes" title="Likes and avoids" description="Staples you cook with. Tap to like, tap again to avoid, once more to clear."
        action={<Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>All ingredients</Button>}>
        <div className="flex flex-wrap gap-2">
          {anchors.map((a) => <PrefChip key={a.slug} name={a.label} state={stateOf(prefs[firstId] ?? { liked: [], avoided: [] }, a.slug)} onClick={() => cycleAnchor(a.slug)} />)}
          {extraLiked.map((sl) => <PrefChip key={sl} name={nameOf.get(sl) ?? sl} state="like" onClick={() => setPickerOpen(true)} />)}
          {extraAvoided.map((sl) => <PrefChip key={sl} name={nameOf.get(sl) ?? sl} state="avoid" onClick={() => setPickerOpen(true)} />)}
        </div>
        <p className="mt-3 text-sm text-muted">{totalLiked} liked, {totalAvoided} avoided{selected.length > 1 ? ". Staples apply to everyone selected; use All ingredients to set one person" : ""}.</p>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard id="health" title="Healthy focus" description="Gentle preferences. Your protein target and the foods you like still come first.">
          <div className="divide-y divide-line">
            <SwitchRow checked={draft.health.nutrientDense} onChange={(v) => setDraft({ health: { ...draft.health, nutrientDense: v } })} title="Nutrient-dense" hint="Favour meals rich in fibre, minerals and vitamins for their calories." />
            <SwitchRow checked={draft.health.lowSugar} onChange={(v) => setDraft({ health: { ...draft.health, lowSugar: v } })} title="Low added sugar" hint="Avoid meals sweetened with sugar, honey, jaggery or dates." />
            <SwitchRow checked={draft.health.light} onChange={(v) => setDraft({ health: { ...draft.health, light: v } })} title="Lighter meals" hint="Favour lower-calorie meals and snacks." />
          </div>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard id="cuisine" title="Cuisine mix" description="How much of the plan is Indian food.">
            <label htmlFor="cuisine" className="sr-only">Cuisine mix</label>
            <input id="cuisine" type="range" min={0} max={1} step={0.1} value={draft.cuisine} onChange={(e) => setDraft({ cuisine: Number(e.target.value) })} className="h-11 w-full accent-[var(--primary)]" aria-valuetext={`${Math.round(draft.cuisine * 100)} percent Indian`} />
            <div className="flex justify-between text-xs text-muted"><span>More global</span><span className="font-semibold text-fg">{Math.round(draft.cuisine * 100)}% Indian</span><span>More Indian</span></div>
          </SectionCard>

          <SectionCard id="pins" title="Pin recipes" description="Pinned recipes are placed once each across the plan.">
            <Button variant="secondary" size="sm" onClick={() => setPinOpen(true)}>{draft.pinned.length ? `${draft.pinned.length} pinned, change` : "Choose recipes"}</Button>
            {pinnedNames.length ? <p className="mt-2 text-sm text-muted">{pinnedNames.join(", ")}</p> : null}
          </SectionCard>
        </div>
      </div>

      <IngredientPicker open={pickerOpen} onClose={() => setPickerOpen(false)} items={ingredients} people={anchorPeople.map((p) => ({ id: p.id, name: p.name }))} prefs={prefs as Record<number, PrefSet>} onChange={(id, next) => setDraft({ prefs: { ...prefs, [id]: next } })} />
      <PinSheet open={pinOpen} onClose={() => setPinOpen(false)} recipes={recipes} pinned={draft.pinned} onChange={(pinned) => setDraft({ pinned })} />
    </div>
  );
}
