import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrepClient } from "@/components/PrepClient";
import type { EatView, NightTask, PrepEventView, PrepSessionView } from "@/components/PrepClient";
import { LinkButton, PageTitle } from "@/components/ui";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { formatDay } from "@/lib/planner/dates";
import type { CookEvent } from "@/lib/prep/session";
import { storageAdvice } from "@/lib/recipes/storage";
import { displayName } from "@/lib/schemas";
import { getData } from "@/lib/server/context";
import { loadNight } from "@/lib/server/prep";
import { getBatchPrepTicks, getPlanView } from "@/lib/server/queries";
import { todayISO } from "@/lib/server/time";

export const metadata: Metadata = { title: "Meal prep guide" };
export const dynamic = "force-dynamic";

const dayLabel = (iso: string) => formatDay(iso).long;
const shortLabel = (iso: string) => {
  const f = formatDay(iso);
  return `${f.short} ${iso.slice(8)}`;
};

export default async function PrepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const planId = Number(id);
  if (!Number.isInteger(planId)) notFound();
  const view = await getPlanView(planId);
  if (!view) notFound();
  const data = getData();
  const today = todayISO();

  const { guide, tasks } = await loadNight(view, today);

  const rows = await getBatchPrepTicks(planId);
  const done = new Set(rows.filter((r) => r.done).map((r) => r.taskKey));

  const night: NightTask[] = tasks.map((t) => ({ key: t.key, dueDate: t.dueDate, dueLabel: shortLabel(t.dueDate), text: t.text, forName: t.forName, done: t.done, today: t.dueDate === today }));

  const covers = (e: CookEvent) => e.covers.map((c) => `${shortLabel(c.date)} ${c.slot}`);
  const toView = (e: CookEvent, first: boolean): PrepEventView => {
    const r = data.recipes.get(e.slug)!;
    const ingredients = [...expandRecipe(e.slug, r.servings * (e.kind === "component" ? e.scale : e.scale), data.recipes)]
      .map(([k, g]) => ({ name: data.ingredients.get(k) ? displayName(data.ingredients.get(k)!) : k, grams: g }))
      .sort((a, b) => b.grams - a.grams);
    const headline =
      e.kind === "component"
        ? `Make ${e.scale}× (${Math.round((e.yieldG ?? 0) * e.scale)} g). You need about ${Math.round(e.neededG ?? 0)} g across the plan`
        : `Cook ${Math.round(e.servings * 10) / 10} servings${e.scale !== 1 ? ` (${Math.round(e.scale * 100) / 100}× the recipe)` : ""}`;
    return {
      id: e.id,
      kind: e.kind,
      slug: e.slug,
      name: e.name,
      cookDate: e.cookDate,
      cookLabel: dayLabel(e.cookDate),
      headline,
      useByLabel: dayLabel(e.useBy),
      covers: covers(e),
      activeMin: e.activeMin,
      totalMin: e.totalMin,
      passiveMin: e.passiveMin,
      startFirst: first && e.passiveMin >= 20,
      equipment: e.equipment,
      ingredients,
      steps: r.steps.map((st) => ({ text: st.text, cue: st.cue ?? null, tip: st.tip ?? null })),
      storage: storageAdvice(r),
      done: done.has(`prep:${planId}:${e.id}`),
    };
  };

  const sessions: PrepSessionView[] = guide.sessions.map((se) => ({
    date: se.date,
    label: `${dayLabel(se.date)}: batch cooking`,
    activeMin: se.activeMin,
    wallMin: se.wallMin,
    equipment: se.equipment,
    events: se.events.map((e, i) => toView(e, i < 2)),
  }));

  const byDate = new Map<string, EatView["meals"]>();
  const order = ["breakfast", "lunch", "dinner", "snack", "shake"];
  for (const l of guide.eat) {
    const r = data.recipes.get(l.recipeSlug);
    const note = l.mode === "batch" ? `From the ${shortLabel(l.cookDate)} batch. Use by ${shortLabel(l.useBy)}. Reheat until steaming hot.` : `Cook fresh. ${r?.active_min ?? 0} minutes of work.`;
    byDate.set(l.date, [...(byDate.get(l.date) ?? []), { slot: l.slot, recipeSlug: l.recipeSlug, name: r?.name ?? l.recipeSlug, mode: l.mode, note, activeMin: l.activeMin }]);
  }
  const eat: EatView[] = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, ms]) => ({ date, label: dayLabel(date), meals: ms.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot)) }));

  return (
    <>
      <PageTitle title="Meal prep guide" sub="What to soak, batch-cook and cook fresh, in order." action={<LinkButton href={`/plan/${planId}`} variant="secondary">Back to plan</LinkButton>} />
      <PrepClient planId={planId} rangeLabel={`${dayLabel(view.startDate)} to ${dayLabel(view.endDate)}`} night={night} sessions={sessions} eat={eat} freshCount={guide.eat.filter((l) => l.mode === "fresh").length} />
    </>
  );
}
