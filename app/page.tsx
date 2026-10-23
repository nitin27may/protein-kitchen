import type { ReactNode } from "react";
import Link from "next/link";
import { DailyBasics } from "@/components/today/DailyBasics";
import { GroceryStatusCard } from "@/components/today/GroceryStatusCard";
import { MealsToday } from "@/components/today/MealsToday";
import { PersonSwitch } from "@/components/today/PersonSwitch";
import { PhaseCard } from "@/components/today/PhaseCard";
import type { SetupSummary } from "@/components/today/PhaseCard";
import { ProteinBars } from "@/components/today/ProteinBars";
import { SnackNow } from "@/components/today/SnackNow";
import { TonightCard } from "@/components/today/TonightCard";
import type { HabitView, MealView, PrepView, SnackView } from "@/components/today/types";
import { Card, EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { SLOT_LABEL } from "@/lib/format";
import { dayPart, firstOpenTask, groupNightTasks, layoutFor, planPhase, shopByDate } from "@/lib/plan/phase";
import type { PanelId } from "@/lib/plan/phase";
import { addDays, formatDay } from "@/lib/planner/dates";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { getData } from "@/lib/server/context";
import { loadNight } from "@/lib/server/prep";
import { getCandidates, getHabitsFor, getPlanView, groceryProgress, lastSetup, latestPlanId, listPeople, listPlans, proteinTargetOf, toPersonTarget } from "@/lib/server/queries";
import { localMinutes, todayISO } from "@/lib/server/time";

export const dynamic = "force-dynamic";

const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack", "shake"];

export default async function Home({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const people = await listPeople();
  if (people.length === 0) {
    return (
      <>
        <PageTitle title="Welcome" sub="Plan a week of high-protein vegetarian meals in about a minute." />
        <EmptyState
          title="Start with a profile"
          body="Your height, weight and protein target size every portion. You can add more people later."
          action={<LinkButton href="/profiles/new?next=/plan/new">Add a profile</LinkButton>}
        />
      </>
    );
  }

  const person = people.find((x) => String(x.id) === p) ?? people[0]!;
  const data = getData();
  const now = new Date();
  const today = todayISO(now);
  const part = dayPart(localMinutes(now));
  const tomorrow = addDays(today, 1);
  const candidates = await getCandidates();
  const planId = await latestPlanId();
  const view = planId ? await getPlanView(planId, candidates) : undefined;

  // Night-before prep, grouped for Today. Overdue tasks are shown here as well as on the prep guide.
  const night = view ? await loadNight(view, today) : undefined;
  const grouped = groupNightTasks(night?.tasks ?? [], today);
  const toView = (t: NonNullable<typeof night>["tasks"][number]): PrepView => ({ key: t.key, text: t.text, forName: t.forName, dueDate: t.dueDate, done: t.done });
  const first = night ? firstOpenTask(night.tasks) : undefined;

  const grocery = view ? await groceryProgress(view) : undefined;
  const phase = planPhase(today, view, grocery, first ? { text: first.text, forName: first.forName, dueDate: first.dueDate } : undefined);
  const layout = layoutFor(phase.kind, part);

  // Daily basics for the chosen person.
  const { habits: habitRows, doneIds: done } = await getHabitsFor(today, person.id);
  const habits: HabitView[] = habitRows
    .map((h) => ({
      slug: h.slug,
      title: h.title,
      grade: h.evidenceGrade as HabitView["grade"],
      note: h.evidenceNote,
      caution: h.caution,
      sourceUrl: h.sourceUrl,
      done: done.has(h.id),
      defaultOn: h.defaultOn && h.category !== "evening_prep_generic",
    }))
    .filter((h) => h.defaultOn || habitRows.find((r) => r.slug === h.slug)?.category !== "evening_prep_generic");

  // Snack ideas by time available, protein-dense first.
  const target = await toPersonTarget(person);
  const pool = candidates.filter((c) => c.mealSlots.includes("snack") && c.family !== "shakes" && c.perServing.protein_g >= 10 && ![...target.avoided].some((a) => c.ingredients.has(a)));
  const rank = (max: number): SnackView[] =>
    pool
      .filter((c) => c.activeMin <= max)
      .sort((a, b) => b.perServing.protein_g / b.perServing.kcal - a.perServing.protein_g / a.perServing.kcal)
      .slice(0, 3)
      .map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, kcal: c.perServing.kcal, minutes: c.activeMin, needsCooking: c.activeMin > 2 }));
  const snacks = { "0": rank(2), "5": rank(5), "10": rank(10) };

  // Meals for the focus day. If nothing is planned for today, show the next planned day instead of an empty screen.
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const plannedDates = new Set((view?.slots ?? []).map((sl) => sl.date));
  const focusDate = plannedDates.has(today) ? today : ([...plannedDates].filter((d) => d > today).sort()[0] ?? today);
  const isToday = focusDate === today;
  const mealsOn = (date: string): MealView[] =>
    (view?.slots ?? [])
      .filter((sl) => sl.date === date)
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
      .map((sl) => {
        const c = byslug.get(sl.recipeSlug);
        const servings = sl.servings[String(person.id)] ?? 0;
        return {
          id: sl.id,
          slot: sl.slot,
          slug: sl.recipeSlug,
          name: c?.name ?? sl.recipeSlug,
          proteinG: (c?.perServing.protein_g ?? 0) * servings,
          kcal: (c?.perServing.kcal ?? 0) * servings,
          activeMin: c?.activeMin ?? 0,
          leftover: sl.isLeftover ?? false,
          image: data.recipes.get(sl.recipeSlug)?.image ?? null,
          thumbs: recipeThumbs(sl.recipeSlug, data.recipes, data.ingredients),
        };
      })
      .filter((m) => m.proteinG > 0 || m.kcal > 0);
  const meals = mealsOn(focusDate);
  const tomorrowFirst = mealsOn(tomorrow)[0];
  const preview = part === "evening" && tomorrowFirst ? { label: SLOT_LABEL[tomorrowFirst.slot] ?? tomorrowFirst.slot, name: tomorrowFirst.name } : null;

  const bars = (view?.people ?? []).map((pp) => ({
    id: pp.id,
    name: pp.name,
    proteinG: view?.days.find((d) => d.date === focusDate && Number(d.personId) === pp.id)?.proteinG ?? 0,
    targetG: proteinTargetOf(pp),
  }));

  const lastSet = await lastSetup();
  const setup: SetupSummary | undefined = lastSet ? { days: lastSet.days, mealTypes: lastSet.mealTypes.map((m) => SLOT_LABEL[m]?.toLowerCase() ?? m), people: lastSet.personIds.length } : undefined;
  const plans = await listPlans(5);
  const shopBy = view && phase.kind !== "no-plan" ? shopByDate(today, view.startDate, first?.dueDate) : null;

  const planHasMeals = phase.kind === "mid-plan" || phase.kind === "last-two-days";
  const panels: Record<PanelId, ReactNode> = {
    hero: (
      <PhaseCard phase={phase} setup={setup}>
        {planHasMeals ? <ProteinBars people={bars} caption={isToday ? "Protein planned for today" : `Protein planned for ${formatDay(focusDate).long}`} /> : null}
      </PhaseCard>
    ),
    grocery: grocery ? <GroceryStatusCard progress={grocery} shopBy={shopBy} today={today} /> : null,
    meals: planHasMeals ? <MealsToday title={isToday ? "Today's meals" : `Meals on ${formatDay(focusDate).long}`} meals={meals} /> : null,
    tonight: view ? <TonightCard tonight={grouped.tonight.map(toView)} overdue={grouped.overdue.map(toView)} preview={preview} today={today} /> : null,
    basics: <DailyBasics key={`${person.id}-${part === "morning"}`} date={today} personId={person.id} habits={habits} defaultOpen={part === "morning"} />,
    snack: <SnackNow snacks={snacks} />,
    links: view ? (
      <Card>
        <h2 className="text-lg font-semibold">Current plan</h2>
        <p className="text-sm text-muted">{formatDay(view.startDate).long} to {formatDay(view.endDate).long}, {view.dates.length} days</p>
        <LinkButton href={`/plan/${view.id}`} variant="secondary" className="mt-3 w-full">Open plan</LinkButton>
        {plans.length > 1 ? (
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {plans.slice(1).map((pl) => (
              <li key={pl.id}><Link href={`/plan/${pl.id}`} className="flex min-h-12 items-center justify-between text-sm hover:text-primary">Earlier: {formatDay(pl.startDate).long} to {formatDay(pl.endDate).short}<span className="font-semibold text-primary">Open</span></Link></li>
            ))}
          </ul>
        ) : null}
      </Card>
    ) : null,
  };

  const render = (ids: PanelId[]) => ids.map((id) => (panels[id] ? <div key={id}>{panels[id]}</div> : null));

  return (
    <>
      <PageTitle title="Today" sub={`${formatDay(today).long}. ${person.name}: ${proteinTargetOf(person)} g protein a day`} action={<LinkButton href="/plan/new" variant={phase.kind === "no-plan" ? "secondary" : "primary"}>New plan</LinkButton>} />
      <PersonSwitch people={people.map((x) => ({ id: x.id, name: x.name }))} activeId={person.id} />
      <div className="space-y-4 px-4 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">{render(layout.main)}</div>
        <aside aria-label="Shopping, basics and snacks" className="space-y-4">{render(layout.side)}</aside>
      </div>
    </>
  );
}
