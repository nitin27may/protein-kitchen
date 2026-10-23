"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createPlan } from "@/app/actions";
import { PlusIcon } from "@/components/icons";
import { IngredientPicker, nextState, PrefChip, stateOf } from "@/components/IngredientPicker";
import type { PickerIngredient, PrefSet } from "@/components/IngredientPicker";
import { Sheet } from "@/components/Sheet";
import { Banner, Button, Chip, ChoiceCard, Field, Input, ResultCount, SearchField, SectionCard, Segmented, SortMenu, SwitchRow } from "@/components/ui";
import { filterPickRecipes, PICK_DEFAULT, PICK_SORTS, pickIsFiltered } from "@/lib/filters/lists";
import type { PickSort } from "@/lib/filters/lists";
import { addDays, datesBetween } from "@/lib/planner/dates";
import { MAX_PLAN_DAYS } from "@/lib/schemas";

export interface SetupPerson {
  id: number;
  name: string;
  proteinTarget: number;
  kcalTarget: number | null;
}

export interface SetupProps {
  people: SetupPerson[];
  ingredients: PickerIngredient[];
  anchors: { slug: string; label: string }[];
  recipes: { slug: string; name: string; proteinG: number; activeMin: number; slots: string[] }[];
  initial: {
    personIds: number[];
    length: "7" | "14" | "custom";
    start: string;
    end: string;
    meals: string[];
    cuisineBalance: number;
    timeLimit: "weeknights" | "always20" | "none";
    health: { nutrientDense: boolean; lowSugar: boolean; light: boolean };
    prepStyle: "variety" | "leftovers" | "batch";
    prefs: Record<number, PrefSet>;
  };
}

const MEALS = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "dinner", label: "Dinner" },
  { id: "snack", label: "Snack" },
  { id: "shake", label: "Shake" },
];

function fmtRange(start: string, end: string): string {
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} to ${f(end)}`;
}

export function SetupForm({ people, ingredients, anchors, recipes, initial }: SetupProps) {
  const router = useRouter();
  const [personIds, setPersonIds] = useState<number[]>(initial.personIds);
  const [length, setLength] = useState(initial.length);
  const [start, setStart] = useState(initial.start);
  const [customEnd, setCustomEnd] = useState(initial.end);
  const [meals, setMeals] = useState<string[]>(initial.meals);
  const [prefs, setPrefs] = useState<Record<number, PrefSet>>(initial.prefs);
  const [cuisine, setCuisine] = useState(initial.cuisineBalance);
  const [timeLimit, setTimeLimit] = useState(initial.timeLimit);
  const [pinned, setPinned] = useState<string[]>([]);
  const [health, setHealth] = useState(initial.health);
  const [prepStyle, setPrepStyle] = useState(initial.prepStyle);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinQ, setPinQ] = useState("");
  const [pinMeal, setPinMeal] = useState("all");
  const [pinSort, setPinSort] = useState<PickSort>("protein");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const end = length === "7" ? addDays(start, 6) : length === "14" ? addDays(start, 13) : customEnd;
  const dayCount = datesBetween(start, end).length;
  const dateProblem = !start ? "Choose a start date." : dayCount < 1 ? "The end date is before the start date." : dayCount > MAX_PLAN_DAYS ? `A plan can cover at most ${MAX_PLAN_DAYS} days.` : null;
  const selected = people.filter((p) => personIds.includes(p.id));
  const blocker = selected.length === 0 ? "Choose at least one person." : meals.length === 0 ? "Choose at least one meal type." : dateProblem;

  const anchorPeople = selected.length ? selected : people.slice(0, 1);
  const firstId = anchorPeople[0]?.id ?? 0;
  const togglePerson = (id: number) => setPersonIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const toggleMeal = (id: string) => setMeals((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  /** Chips at the top act on every selected person at once, so one tap covers the household. */
  function cycleAnchor(slug: string) {
    setPrefs((cur) => {
      const base = cur[firstId] ?? { liked: [], avoided: [] };
      const target = nextState(base, slug);
      const next = { ...cur };
      for (const p of anchorPeople) {
        const prev = next[p.id] ?? { liked: [], avoided: [] };
        const liked = prev.liked.filter((s) => s !== slug);
        const avoided = prev.avoided.filter((s) => s !== slug);
        if (target.liked.includes(slug)) liked.push(slug);
        if (target.avoided.includes(slug)) avoided.push(slug);
        next[p.id] = { liked, avoided };
      }
      return next;
    });
  }

  const totalLiked = new Set(anchorPeople.flatMap((p) => prefs[p.id]?.liked ?? [])).size;
  const totalAvoided = new Set(anchorPeople.flatMap((p) => prefs[p.id]?.avoided ?? [])).size;
  const nameOf = useMemo(() => new Map(ingredients.map((i) => [i.slug, i.name])), [ingredients]);
  const extraAvoided = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.avoided ?? []))].filter((s) => !anchors.some((a) => a.slug === s));
  const extraLiked = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.liked ?? []))].filter((s) => !anchors.some((a) => a.slug === s));

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await createPlan({
        personIds,
        startDate: start,
        endDate: end,
        mealTypes: meals as ("breakfast" | "lunch" | "dinner" | "snack" | "shake")[],
        cuisineBalance: cuisine,
        maxActiveMin: timeLimit === "always20" ? 20 : timeLimit === "none" ? 999 : null,
        pinned,
        healthFocus: health,
        prepStyle,
        prefs: Object.fromEntries(selected.map((p) => [String(p.id), prefs[p.id] ?? { liked: [], avoided: [] }])),
      });
      if (!res.ok) {
        setError(res.error);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      router.push(`/plan/${res.planId}`);
    });
  }

  const pinState = { ...PICK_DEFAULT, q: pinQ, meal: pinMeal, sort: pinSort };
  const pinMatches = filterPickRecipes(recipes, pinState).slice(0, 60);
  const pinTotal = filterPickRecipes(recipes, pinState).length;
  const mealCount = dayCount > 0 ? dayCount * meals.length : 0;
  const STYLE_LABEL = { variety: "Variety", leftovers: "Cook once, eat twice", batch: "Batch cook" } as const;
  const likedNames = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.liked ?? []))].map((s) => nameOf.get(s) ?? anchors.find((a) => a.slug === s)?.label ?? s);
  const avoidedNames = [...new Set(anchorPeople.flatMap((p) => prefs[p.id]?.avoided ?? []))].map((s) => nameOf.get(s) ?? anchors.find((a) => a.slug === s)?.label ?? s);
  const healthOn = [health.nutrientDense && "nutrient-dense", health.lowSugar && "low sugar", health.light && "lighter"].filter(Boolean).join(", ");
  const timeHint = timeLimit === "weeknights" ? "Weeknights keep active cooking to 20 minutes or less. Weekends can be longer." : timeLimit === "always20" ? "Every meal is 20 minutes or less of active cooking." : "Any recipe can be picked, however long it takes.";

  const names = (list: string[]) => (list.length === 0 ? "None" : list.length > 4 ? `${list.slice(0, 4).join(", ")} and ${list.length - 4} more` : list.join(", "));

  return (
    <div className="px-4 pb-32 lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-6 lg:pb-10 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-4">
        {error ? <Banner tone="bad" title="Could not make the plan">{error}</Banner> : null}

        <div className="grid gap-4 xl:grid-cols-2">
          <SectionCard id="who" title="Who is eating" description="Protein targets come from each profile.">
            <div className="flex flex-wrap gap-2">
              {people.map((p) => <Chip key={p.id} on={personIds.includes(p.id)} onClick={() => togglePerson(p.id)}>{p.name}</Chip>)}
              <a href="/profiles/new?next=/plan/new" className="inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-strong px-3.5 text-sm font-semibold text-primary hover:bg-primarysoft lg:min-h-9"><PlusIcon className="size-4" />Add person</a>
            </div>
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {selected.map((p) => (
                <li key={p.id}><strong className="text-fg">{p.name}</strong>: {p.proteinTarget} g protein{p.kcalTarget ? `, ${p.kcalTarget} kcal` : ""} a day. <a className="font-semibold text-primary underline-offset-2 hover:underline" href={`/profiles/${p.id}`}>Edit</a></li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard id="meals" title="Meals each day" description={meals.includes("shake") ? "A shake is added every day, because you turned it on." : "A shake is only added when you turn it on."}>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Meals to plan">
              {MEALS.map((m) => <Chip key={m.id} on={meals.includes(m.id)} onClick={() => toggleMeal(m.id)}>{m.label}</Chip>)}
            </div>
          </SectionCard>
        </div>

        <SectionCard id="len" title="When" description="Plans start on a Monday by default.">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <Segmented value={length} onChange={(val) => { setLength(val); if (val === "custom") setCustomEnd(addDays(start, 2)); }} label="Plan length" options={[{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "custom", label: "Custom" }]} />
            <Field label="Start" htmlFor="start"><Input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-44" /></Field>
            <Field label="End" htmlFor="end"><Input id="end" type="date" value={end} disabled={length !== "custom"} onChange={(e) => setCustomEnd(e.target.value)} className="w-44" /></Field>
          </div>
          <p className={`mt-3 text-sm ${dateProblem ? "text-bad" : "text-muted"}`} role={dateProblem ? "alert" : undefined}>
            {dateProblem ?? <>{fmtRange(start, end)}, <strong className="text-fg">{dayCount} {dayCount === 1 ? "day" : "days"}</strong>.{dayCount > 14 ? " Long plans make a long grocery list; you can shop week by week from it." : ""}</>}
          </p>
        </SectionCard>

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
          <SectionCard id="style" title="Cooking style" description="How much you want to cook once and eat again.">
            <div className="grid gap-2" role="radiogroup" aria-labelledby="style">
              {([
                ["variety", "Variety", "Different meals every day. Most cooking."],
                ["leftovers", "Cook once, eat twice", "Dinner is eaten again as the next day's lunch."],
                ["batch", "Batch cook", "Each lunch repeats for 2 to 3 days. Least cooking."],
              ] as const).map(([v, label, hint]) => (
                <ChoiceCard key={v} type="radio" name="prepstyle" checked={prepStyle === v} onChange={() => setPrepStyle(v)} title={label} hint={hint} />
              ))}
            </div>
          </SectionCard>

          <SectionCard id="health" title="Healthy focus" description="Gentle preferences. Your protein target and the foods you like still come first.">
            <div className="divide-y divide-line">
              <SwitchRow checked={health.nutrientDense} onChange={(v) => setHealth((h) => ({ ...h, nutrientDense: v }))} title="Nutrient-dense" hint="Favour meals rich in fibre, minerals and vitamins for their calories." />
              <SwitchRow checked={health.lowSugar} onChange={(v) => setHealth((h) => ({ ...h, lowSugar: v }))} title="Low added sugar" hint="Avoid meals sweetened with sugar, honey, jaggery or dates." />
              <SwitchRow checked={health.light} onChange={(v) => setHealth((h) => ({ ...h, light: v }))} title="Lighter meals" hint="Favour lower-calorie meals and snacks." />
            </div>
          </SectionCard>
        </div>

        <SectionCard id="tune" title="Fine-tune" description="Defaults are fine for most weeks.">
          <div className="grid gap-6 xl:grid-cols-3">
            <div>
              <label htmlFor="cuisine" className="mb-1 block text-sm font-semibold">Cuisine mix</label>
              <input id="cuisine" type="range" min={0} max={1} step={0.1} value={cuisine} onChange={(e) => setCuisine(Number(e.target.value))} className="h-11 w-full accent-[var(--primary)]" aria-valuetext={`${Math.round(cuisine * 100)} percent Indian`} />
              <div className="flex justify-between text-xs text-muted"><span>More global</span><span className="font-semibold text-fg">{Math.round(cuisine * 100)}% Indian</span><span>More Indian</span></div>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold" id="limit-l">Active cooking time</p>
              <Segmented value={timeLimit} onChange={setTimeLimit} label="Active cooking time" options={[{ value: "weeknights", label: "Weeknights" }, { value: "always20", label: "Every day" }, { value: "none", label: "No limit" }]} className="w-full" />
              <p className="mt-1 text-sm text-muted">{timeHint}</p>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Pin recipes</p>
              <Button variant="secondary" size="sm" onClick={() => setPinOpen(true)}>{pinned.length ? `${pinned.length} pinned, change` : "Choose recipes"}</Button>
              <p className="mt-1 text-sm text-muted">{pinned.length ? pinned.map((sl) => recipes.find((r) => r.slug === sl)?.name ?? sl).join(", ") : "Pinned recipes are placed once each across the plan."}</p>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Desktop summary: the plan as it will be made, with the one action beside it. */}
      <aside aria-label="Plan summary" className="hidden lg:sticky lg:top-4 lg:block">
        <div className="rounded-card border border-line bg-surface p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Your plan</h2>
          <div className="mt-3 flex items-end gap-6">
            <div><p className="font-display text-5xl font-bold tabular-nums leading-none">{dayCount > 0 ? dayCount : 0}</p><p className="mt-1 text-sm text-muted">{dayCount === 1 ? "day" : "days"}</p></div>
            <div><p className="font-display text-5xl font-bold tabular-nums leading-none text-accent">{mealCount}</p><p className="mt-1 text-sm text-muted">meals</p></div>
          </div>
          <p className="mt-2 text-sm text-muted">{dateProblem ? "Check the dates." : fmtRange(start, end)}</p>

          <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
            <div><dt className="text-muted">Eating</dt><dd className="font-medium">{selected.length ? selected.map((p) => `${p.name} (${p.proteinTarget} g)`).join(", ") : "No one selected"}</dd></div>
            <div><dt className="text-muted">Meals</dt><dd className="font-medium">{meals.length ? MEALS.filter((m) => meals.includes(m.id)).map((m) => m.label).join(", ") : "None selected"}</dd></div>
            <div><dt className="text-muted">Style</dt><dd className="font-medium">{STYLE_LABEL[prepStyle]}</dd></div>
            <div><dt className="text-muted">Likes</dt><dd className="font-medium">{names(likedNames)}</dd></div>
            <div><dt className="text-muted">Avoids</dt><dd className="font-medium">{names(avoidedNames)}</dd></div>
            <div><dt className="text-muted">Focus</dt><dd className="font-medium">{healthOn || "None"}</dd></div>
          </dl>

          {blocker ? <p className="mt-4 text-sm text-bad" role="alert">{blocker}</p> : null}
          <Button size="lg" className="mt-4 w-full" onClick={generate} loading={pending} disabled={!!blocker}>{pending ? "Planning" : "Generate plan"}</Button>
          <p className="mt-2 text-center text-xs text-muted">You can swap or lock any meal afterwards.</p>
        </div>
      </aside>

      {/* Phone: the same action in a bar that stays in reach. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        {blocker ? <p className="mb-2 text-sm text-bad" role="alert">{blocker}</p> : <p className="mb-2 text-sm text-muted">{dayCount} {dayCount === 1 ? "day" : "days"}, {mealCount} meals, {selected.length} {selected.length === 1 ? "person" : "people"}</p>}
        <Button size="lg" className="w-full" onClick={generate} loading={pending} disabled={!!blocker}>{pending ? "Planning" : "Generate plan"}</Button>
      </div>

      <IngredientPicker open={pickerOpen} onClose={() => setPickerOpen(false)} items={ingredients} people={anchorPeople.map((p) => ({ id: p.id, name: p.name }))} prefs={prefs} onChange={(id, next) => setPrefs((cur) => ({ ...cur, [id]: next }))} />

      <Sheet open={pinOpen} onClose={() => setPinOpen(false)} title="Pin recipes">
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField id="pin-search" label="Search recipes" value={pinQ} onChange={setPinQ} placeholder="Search recipes" className="min-w-[12rem] flex-1" />
            <SortMenu value={pinSort} onChange={(v) => setPinSort(v as PickSort)} options={PICK_SORTS} />
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Meal type">
            <Chip on={pinMeal === "all"} onClick={() => setPinMeal("all")}>All meals</Chip>
            {MEALS.map((m) => <Chip key={m.id} on={pinMeal === m.id} onClick={() => setPinMeal(pinMeal === m.id ? "all" : m.id)}>{m.label}</Chip>)}
          </div>
          <div className="mt-2"><ResultCount shown={pinTotal} total={recipes.length} noun="recipes" onClear={pickIsFiltered(pinState) ? () => { setPinQ(""); setPinMeal("all"); } : undefined} /></div>
          {pinned.length ? <p className="mt-1 text-sm text-muted">{pinned.length} pinned</p> : null}
          {pinTotal > pinMatches.length ? <p className="mt-1 text-sm text-muted">Showing the first {pinMatches.length}. Search or filter to see the rest.</p> : null}
          <ul className="mt-2 divide-y divide-line">
            {pinMatches.map((r) => {
              const on = pinned.includes(r.slug);
              return (
                <li key={r.slug}>
                  <button type="button" aria-pressed={on} onClick={() => setPinned((c) => (on ? c.filter((x) => x !== r.slug) : [...c, r.slug]))} className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left">
                    <span><span className="block font-medium">{r.name}</span><span className="text-xs text-muted">{Math.round(r.proteinG)} g protein per serving, {r.activeMin} min</span></span>
                    <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-primary bg-primarysoft text-primary" : "border-strong text-muted"}`}>{on ? "Pinned" : "Pin"}</span>
                  </button>
                </li>
              );
            })}
            {pinMatches.length === 0 ? <li className="p-4 text-center text-muted">Nothing matches. Clear a filter to see more.</li> : null}
          </ul>
        </div>
      </Sheet>
    </div>
  );
}
