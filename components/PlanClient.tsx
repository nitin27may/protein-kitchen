"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deletePlan, enableShake, getSwapOptions, regeneratePlan, setPortion, swapSlot, toggleLock } from "@/app/actions";
import type { SwapOption } from "@/app/actions";
import { RecipeThumb } from "@/components/RecipeThumb";
import { announcePlanStep, NextSteps } from "@/components/plan/NextSteps";
import { PlanRoutinesCard } from "@/components/routines/PlanRoutinesCard";
import type { PlanMilestones } from "@/lib/planner/feasibility-types";
import type { PlanRoutineRow } from "@/lib/routines/view";
import { Sheet } from "@/components/Sheet";
import { CheckIcon, SlidersIcon } from "@/components/icons";
import { Banner, Button, Card, LinkButton, MacroLine, Pill, ProteinBar, SearchField, Segmented, SortMenu } from "@/components/ui";
import { filterPickRecipes, PICK_DEFAULT, PICK_SORTS, PICK_TIMES, pickIsFiltered } from "@/lib/filters/lists";
import type { PickSort, PickTime } from "@/lib/filters/lists";
import { SLOT_LABEL } from "@/lib/format";
import { portionText } from "@/lib/nutrition/portion";
import type { PlanExport } from "@/lib/export/model";
import type { ServingUnit } from "@/lib/schemas";
import dynamic from "next/dynamic";

export interface PlanSlotView {
  id: number;
  date: string;
  slot: string;
  recipeSlug: string;
  recipeName: string;
  proteinG: number;
  kcal: number;
  activeMin: number;
  locked: boolean;
  servings: Record<string, number>;
  image: string | null;
  thumbs: string[];
  dense: boolean;
  lowSugar: boolean;
  light: boolean;
  leftover: boolean;
  /** Approximate plate weight of one recipe serving. */
  servingG: number;
  unit: ServingUnit | null;
}

export interface PlanProps {
  planId: number;
  dates: { iso: string; short: string; long: string; dayNum: string }[];
  startIndex: number;
  mealTypes: string[];
  people: { id: number; name: string; target: number }[];
  days: { date: string; personId: number; proteinG: number; kcal: number }[];
  slots: PlanSlotView[];
  allRecipes: { slug: string; name: string; proteinG: number; activeMin: number; slots: string[] }[];
  sheet: PlanExport;
  /** Routines this plan was made with, ready to show. */
  routines: PlanRoutineRow[];
  /** Which of the three after-plan steps are done. */
  milestones: PlanMilestones;
}

const SheetView = dynamic(() => import("./SheetView").then((m) => m.SheetView), { ssr: false, loading: () => <p className="px-4 pt-4 text-sm text-muted">Loading the spreadsheet...</p> });

export function PlanClient(p: PlanProps) {
  const router = useRouter();
  const [day, setDay] = useState(p.startIndex);
  const [view, setView] = useState<"day" | "overview" | "sheet">("day");
  const [swapFor, setSwapFor] = useState<PlanSlotView | null>(null);
  const [portionFor, setPortionFor] = useState<PlanSlotView | null>(null);
  const [options, setOptions] = useState<SwapOption[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const [swapTime, setSwapTime] = useState<PickTime>("any");
  const [swapSort, setSwapSort] = useState<PickSort>("protein");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const tabsRef = useRef<HTMLDivElement>(null);

  const current = p.dates[day] ?? p.dates[0]!;
  const todays = p.slots.filter((s) => s.date === current.iso);
  const order = ["breakfast", "lunch", "dinner", "snack", "shake"];
  const sorted = [...todays].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  const shakeOn = p.mealTypes.includes("shake");

  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [day]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success?: string, reviewed = false) {
    setMessage(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setMessage({ tone: "bad", text: res.error ?? "Something went wrong" });
      else {
        if (success) setMessage({ tone: "ok", text: success });
        // A swap or a lock means the person is looking through the plan: count the review step as done.
        if (reviewed) announcePlanStep(p.planId, "reviewed");
        router.refresh();
      }
    });
  }

  function openSwap(slot: PlanSlotView) {
    setSwapFor(slot);
    setOptions(null);
    setShowAll(false);
    setQ("");
    setSwapTime("any");
    setSwapSort("protein");
    getSwapOptions(p.planId, slot.id).then((r) => setOptions(r.ok ? r.options : []));
  }

  const gaps = p.people
    .map((person) => {
      const d = p.days.find((x) => x.date === current.iso && x.personId === person.id);
      return d ? { person, gap: Math.round(person.target - d.proteinG) } : null;
    })
    .filter((x): x is { person: PlanProps["people"][number]; gap: number } => !!x && x.gap >= 5);

  const lowestSwappable = [...sorted].filter((s) => !s.locked).sort((a, b) => a.proteinG - b.proteinG)[0];
  const forSlot = useMemo(() => p.allRecipes.filter((r) => swapFor && r.slots.includes(swapFor.slot)), [p.allRecipes, swapFor]);
  const swapState = { ...PICK_DEFAULT, q, time: swapTime, sort: swapSort };
  const allForSlot = useMemo(
    () => filterPickRecipes(forSlot, { ...PICK_DEFAULT, q, time: swapTime, sort: swapSort }),
    [forSlot, q, swapTime, swapSort],
  );

  const kcalFor = (personId: number) => Math.round(p.days.find((x) => x.date === current.iso && x.personId === personId)?.kcal ?? 0);

  /** Plan-level actions: Groceries is the main one, the rest are secondary, and Delete is set apart and confirmed. */
  const actions = (
    <Card className="space-y-3">
      <h2 className="text-base font-semibold">This plan</h2>
      <LinkButton href="/groceries" size="lg" className="w-full">Open grocery list</LinkButton>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <LinkButton href={`/plan/${p.planId}/prep`} variant="secondary" className="sm:col-span-2 lg:col-span-1 xl:col-span-2">Meal prep guide</LinkButton>
        <Button variant="secondary" loading={pending} onClick={() => run(() => regeneratePlan(p.planId), "New plan made. Locked meals were kept.")}>Regenerate</Button>
        <LinkButton href="/plan/new" variant="secondary">New plan</LinkButton>
      </div>
      <div className="border-t border-line pt-3">
        {confirmDelete ? (
          <div className="space-y-2" role="alertdialog" aria-label="Confirm delete plan">
            <p className="text-sm font-semibold text-bad">Delete this plan and its grocery ticks? This cannot be undone.</p>
            <div className="flex gap-2">
              <Button variant="danger" loading={pending} onClick={() => run(async () => { const r = await deletePlan(p.planId); if (r.ok) router.push("/"); return r; })}>Delete plan</Button>
              <Button variant="secondary" disabled={pending} onClick={() => setConfirmDelete(false)}>Keep it</Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>Delete plan</Button>
        )}
      </div>
    </Card>
  );

  const routinesCard = <PlanRoutinesCard rows={p.routines} people={p.people.map((x) => ({ id: x.id, name: x.name }))} />;

  return (
    <div className="pb-6">
      <NextSteps planId={p.planId} milestones={p.milestones} />
      {/* Date strip */}
      <div ref={tabsRef} role="tablist" aria-label="Days" className="sticky top-14 z-10 flex gap-1.5 overflow-x-auto border-b border-line bg-bg/95 px-3 py-2 backdrop-blur lg:top-0 lg:px-4">
        {p.dates.map((d, i) => {
          const on = i === day && view === "day";
          return (
            <button key={d.iso} role="tab" type="button" aria-selected={i === day} onClick={() => { setDay(i); setView("day"); }}
              className={`flex min-h-14 min-w-14 shrink-0 flex-col items-center justify-center rounded-control border px-2 text-sm transition-colors lg:min-w-16 ${on ? "border-primary bg-primarysoft font-semibold text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>
              <span>{d.short}</span>
              <span className="font-display text-lg font-semibold tabular-nums leading-tight">{d.dayNum}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 lg:px-4">
        <h1 className="text-2xl font-bold leading-tight">{view === "day" ? current.long : view === "sheet" ? "Spreadsheet" : "Whole plan"}</h1>
        <Segmented value={view} onChange={setView} label="View" options={[{ value: "day", label: "Day" }, { value: "overview", label: "Overview" }, { value: "sheet", label: "Sheet" }]} />
      </div>

      {message ? <div className="px-4 pt-3 lg:px-4"><Banner tone={message.tone === "ok" ? "ok" : "bad"}>{message.text}</Banner></div> : null}

      {view === "sheet" ? (
        <SheetView planId={p.planId} plan={p.sheet} />
      ) : view === "overview" ? (
        <div className="px-4 pt-3">
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="bg-surface2">
                  <th className="p-3 text-left font-semibold">Day</th>
                  {p.mealTypes.map((m) => <th key={m} className="p-3 text-left font-semibold">{SLOT_LABEL[m]}</th>)}
                </tr>
              </thead>
              <tbody>
                {p.dates.map((d, i) => (
                  <tr key={d.iso} className="border-t border-line align-top">
                    <th scope="row" className="p-3 text-left font-semibold"><button type="button" className="min-h-11 text-left text-primary underline-offset-2 hover:underline" onClick={() => { setDay(i); setView("day"); }}>{d.short} {d.dayNum}</button></th>
                    {p.mealTypes.map((m) => {
                      const sl = p.slots.find((x) => x.date === d.iso && x.slot === m);
                      return <td key={m} className="p-3">{sl ? <>{sl.locked ? <span className="font-semibold text-primary">Locked: </span> : null}{sl.recipeName}</> : <span className="text-muted">None</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm text-muted">Overview is read-only. Open a day to swap or lock a meal.</p>
        </div>
      ) : (
        <div className="space-y-4 px-4 pt-4 lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_23rem]">
          <aside aria-label="Protein today" className="space-y-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1">
            <Card className="space-y-4">
              <h2 className="text-base font-semibold">Protein today</h2>
              {p.people.map((person) => {
                const d = p.days.find((x) => x.date === current.iso && x.personId === person.id);
                const prot = d?.proteinG ?? 0;
                return (
                  <div key={person.id} className="space-y-2">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        {p.people.length > 1 ? <p className="text-sm text-muted">{person.name}</p> : null}
                        <p className="font-display text-4xl font-bold tabular-nums leading-none">{Math.round(prot)}<span className="ml-1 text-base font-medium text-muted">of {Math.round(person.target)} g</span></p>
                      </div>
                      <p className="text-sm text-muted tabular-nums">{kcalFor(person.id)} kcal</p>
                    </div>
                    <ProteinBar value={prot} target={person.target} label={p.people.length > 1 ? person.name : "Protein today"} />
                  </div>
                );
              })}
            </Card>

            {gaps.length ? (
              <Banner tone="warn" title={gaps.map((g) => `${g.person.name} is ${g.gap} g under target`).join(". ") + "."}>
                <p>{shakeOn ? "Swap a meal for a higher-protein one." : "Swap a meal for a higher-protein one, or turn on a daily shake."}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {lowestSwappable ? <Button variant="secondary" size="sm" onClick={() => openSwap(lowestSwappable)}>Show swaps</Button> : null}
                  {!shakeOn ? <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(() => enableShake(p.planId), "Daily shake added. Locked meals were kept.")}>Add shake</Button> : null}
                </div>
              </Banner>
            ) : null}

            <div className="hidden space-y-4 lg:block">{actions}{routinesCard}</div>
          </aside>

          <ul className="grid content-start gap-3 md:grid-cols-2 lg:col-start-1 lg:row-start-1">
            {sorted.map((s) => (
              <li key={s.id} className={`flex flex-col overflow-hidden rounded-card border bg-surface ${s.locked ? "border-primary/60" : "border-line"}`}>
                <div className="flex gap-3 p-3 md:flex-1 md:flex-col md:p-0">
                  <RecipeThumb image={s.image} thumbs={s.thumbs} label={SLOT_LABEL[s.slot] ?? s.slot} className="aspect-[4/3] w-24 shrink-0 rounded-control md:aspect-[16/9] md:w-full md:rounded-none" />
                  <div className="min-w-0 flex-1 md:px-4 md:pb-3">
                    <p className="text-sm font-semibold text-primary">{SLOT_LABEL[s.slot]}</p>
                    <Link href={`/recipes/${s.recipeSlug}?plan=${p.planId}`} className="block text-lg font-semibold leading-snug hover:underline">{s.recipeName}</Link>
                    <MacroLine protein={s.proteinG} kcal={s.kcal} minutes={s.activeMin} />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {s.leftover ? <Pill tone="warn">Leftover, no cooking</Pill> : null}
                      {s.dense ? <Pill tone="ok">Nutrient-dense</Pill> : null}
                      {s.light ? <Pill tone="info">Light</Pill> : null}
                      {s.lowSugar ? <Pill tone="info">Low sugar</Pill> : null}
                    </div>
                    <ul className="mt-2 space-y-0.5 text-sm">
                      {p.people.map((person) => {
                        const t = portionText(s.servings[String(person.id)] ?? 0, s.servingG, s.unit);
                        return (
                          <li key={person.id}>
                            {p.people.length > 1 ? <span className="text-muted">{person.name}: </span> : null}
                            <span className="font-semibold">{t.amount}</span>
                            <span className="text-muted"> ({t.detail})</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
                <div className="flex gap-2 border-t border-line p-2">
                  <Button variant="secondary" size="sm" className="flex-1" disabled={s.locked} onClick={() => openSwap(s)}>Swap</Button>
                  <Button variant="secondary" size="sm" className="flex-1" onClick={() => setPortionFor(s)}><SlidersIcon className="size-4" />Portions</Button>
                  <Button variant="secondary" size="sm" className={`flex-1 ${s.locked ? "border-primary bg-primarysoft text-primary" : ""}`} aria-pressed={s.locked} disabled={pending} onClick={() => run(() => toggleLock(p.planId, s.id, !s.locked), undefined, true)}>
                    {s.locked ? <CheckIcon className="size-4" /> : null}{s.locked ? "Locked" : "Lock"}
                  </Button>
                </div>
              </li>
            ))}
            {sorted.length === 0 ? <li className="rounded-card border border-dashed border-line p-6 text-center text-muted md:col-span-2">No meals this day.</li> : null}
          </ul>
        </div>
      )}

      <div className={`mt-6 space-y-4 px-4 ${view === "day" ? "lg:hidden" : "lg:max-w-md"}`}>{actions}{routinesCard}</div>

      {/* Swap sheet */}
      <Sheet open={!!swapFor} onClose={() => setSwapFor(null)} title="Swap meal">
        {swapFor ? (
          <div className="p-4">
            <p className="text-sm text-muted">{SLOT_LABEL[swapFor.slot]}, now: <strong className="text-fg">{swapFor.recipeName}</strong> ({Math.round(swapFor.proteinG)} g protein)</p>
            {!showAll ? (
              <>
                <ul className="mt-3 space-y-2" aria-busy={options === null}>
                  {options === null ? <li className="p-4 text-center text-muted">Finding good swaps…</li> : null}
                  {options?.length === 0 ? <li className="rounded-card border border-dashed border-line p-4 text-center text-muted">No close matches. Choose any recipe below.</li> : null}
                  {options?.map((o) => (
                    <li key={o.slug} className="rounded-card border border-strong p-3">
                      <p className="text-base font-semibold">{o.name}</p>
                      <p className="text-sm text-muted tabular-nums">{o.proteinG} g protein · {o.kcal} kcal · {o.reason}</p>
                      <Button className="mt-2 w-full" disabled={pending} onClick={() => run(async () => { const r = await swapSlot(p.planId, swapFor.id, o.slug); if (r.ok) setSwapFor(null); return r; }, `Swapped to ${o.name}.`, true)}>Pick this</Button>
                    </li>
                  ))}
                </ul>
                <Button variant="secondary" className="mt-3 w-full" onClick={() => setShowAll(true)}>Choose any recipe</Button>
              </>
            ) : (
              <>
                <div className="mt-3 space-y-3">
                  <SearchField id="swap-q" label="Search recipes" value={q} onChange={setQ} placeholder="Search recipes" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Segmented<PickTime> value={swapTime} onChange={setSwapTime} label="Active cooking time" options={PICK_TIMES} />
                    <SortMenu value={swapSort} onChange={(v) => setSwapSort(v as PickSort)} options={PICK_SORTS} />
                  </div>
                  <p className="flex items-center gap-3 text-sm text-muted" aria-live="polite">
                    <span>{allForSlot.length} of {forSlot.length} {SLOT_LABEL[swapFor.slot]?.toLowerCase() ?? "meal"} recipes</span>
                    {pickIsFiltered(swapState, true) ? <button type="button" onClick={() => { setQ(""); setSwapTime("any"); }} className="min-h-11 font-semibold text-primary underline-offset-2 hover:underline lg:min-h-9">Clear filters</button> : null}
                  </p>
                </div>
                <ul className="mt-1 divide-y divide-line">
                  {allForSlot.map((r) => (
                    <li key={r.slug}>
                      <button type="button" disabled={pending} onClick={() => run(async () => { const res = await swapSlot(p.planId, swapFor.id, r.slug); if (res.ok) setSwapFor(null); return res; }, `Swapped to ${r.name}.`, true)} className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left">
                        <span className="font-medium">{r.name}</span>
                        <span className="shrink-0 text-sm text-muted tabular-nums">{Math.round(r.proteinG)} g · {r.activeMin} min</span>
                      </button>
                    </li>
                  ))}
                  {allForSlot.length === 0 ? <li className="p-4 text-center text-muted">Nothing matches. Clear a filter to see more.</li> : null}
                </ul>
                <Button variant="ghost" className="mt-2 w-full" onClick={() => setShowAll(false)}>Back to suggestions</Button>
              </>
            )}
          </div>
        ) : null}
      </Sheet>

      {/* Portions sheet */}
      <Sheet open={!!portionFor} onClose={() => setPortionFor(null)} title="Portions">
        {portionFor ? (
          <div className="space-y-4 p-4">
            <p className="text-sm text-muted">{portionFor.recipeName}. One recipe is cooked once; each person eats their own portion.</p>
            {p.people.map((person) => {
              const cur = p.slots.find((x) => x.id === portionFor.id)?.servings[String(person.id)] ?? 0;
              return (
                <div key={person.id} className="flex items-center justify-between gap-3">
                  <span className="text-base font-semibold">{person.name}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label={`Fewer servings for ${person.name}`} disabled={pending || cur <= 0.25} onClick={() => run(() => setPortion(p.planId, portionFor.id, person.id, cur - 0.25))} className="size-11 rounded-control border border-strong text-xl font-semibold hover:bg-surface2 disabled:opacity-40">−</button>
                    <span className="w-28 text-center leading-tight" aria-live="polite">
                      <span className="block text-lg font-semibold">{portionText(cur, portionFor.servingG, portionFor.unit).amount}</span>
                      <span className="block text-xs text-muted">{portionText(cur, portionFor.servingG, portionFor.unit).detail}</span>
                    </span>
                    <button type="button" aria-label={`More servings for ${person.name}`} disabled={pending || cur >= 4} onClick={() => run(() => setPortion(p.planId, portionFor.id, person.id, cur + 0.25))} className="size-11 rounded-control border border-strong text-xl font-semibold hover:bg-surface2 disabled:opacity-40">+</button>
                  </div>
                </div>
              );
            })}
            <Button className="w-full" onClick={() => setPortionFor(null)}>Done</Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
