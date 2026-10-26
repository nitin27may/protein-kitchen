import { requirePageMember } from "@/lib/auth/access";
import { optionalPageMember } from "@/lib/auth/public-access";
import { AnonymousHome } from "@/components/AnonymousHome";
import { libraryPhotoManifest } from "@/lib/library-photos/manifest";
import { libraryHighlights } from "@/lib/library/anonymous";
import type { ReactNode } from "react";
import Link from "next/link";
import { DailyBasics } from "@/components/today/DailyBasics";
import { GroceryStatusCard } from "@/components/today/GroceryStatusCard";
import { AddFoodButton } from "@/components/foods-log/AddFoodButton";
import { DaySwitch } from "@/components/foods-log/DaySwitch";
import { FoodLogProvider } from "@/components/foods-log/FoodLogProvider";
import { MealsToday } from "@/components/today/MealsToday";
import type { DayLog } from "@/components/today/MealsToday";
import { MorningRoutines } from "@/components/today/MorningRoutines";
import type { RoutineItem } from "@/components/today/MorningRoutines";
import { PersonSwitch } from "@/components/today/PersonSwitch";
import { PhaseCard } from "@/components/today/PhaseCard";
import type { SetupSummary } from "@/components/today/PhaseCard";
import { ProteinBars } from "@/components/today/ProteinBars";
import type { PersonBar } from "@/components/today/ProteinBars";
import { SnackNow } from "@/components/today/SnackNow";
import { TonightCard } from "@/components/today/TonightCard";
import type { HabitView, MealView, PrepView, SnackView } from "@/components/today/types";
import { Card, EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { SLOT_LABEL } from "@/lib/format";
import { dayPart, firstOpenTask, groupNightTasks, layoutFor, planPhase, shopByDate, showNextSteps } from "@/lib/plan/phase";
import type { PanelId } from "@/lib/plan/phase";
import { NextSteps } from "@/components/plan/NextSteps";
import { addDays, formatDay } from "@/lib/planner/dates";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { catalogByHabit, getRoutineCatalog } from "@/lib/routines/catalog";
import { routineDayTotals, withoutRoutineHabits } from "@/lib/routines/schedule";
import { summaryLine } from "@/lib/routines/view";
import { entryViews, eatenBar, mealAnswer } from "@/lib/food-log/day-view";
import { plannedMealsFrom } from "@/lib/food-log/keys";
import { nutritionLookups } from "@/lib/food-log/lookups";
import { getData } from "@/lib/server/context";
import { getFoodEntries, getHouseholdFoodRows } from "@/lib/server/food-log-queries";
import { getPhotoIndex } from "@/lib/server/queries";
import { loadNight } from "@/lib/server/prep";
import { getCandidates, getHabitsFor, getPersonRoutines, getPlanView, getTodayRoutines, groceryProgress, lastSetup, latestPlanId, latestPlanMilestones, listPeople, listPlans, proteinTargetOf, toPersonTarget } from "@/lib/server/queries";
import { localMinutes, todayISO } from "@/lib/server/time";

export const dynamic = "force-dynamic";

const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack", "shake"];

export default async function Home({ searchParams }: { searchParams: Promise<{ p?: string; d?: string }> }) {
  const publicMember = await optionalPageMember();
  if (!publicMember) return <AnonymousHome highlights={libraryHighlights(getData(), undefined, await libraryPhotoManifest())} />;
  const member = await requirePageMember();
  const { p, d: dayParam } = await searchParams;
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

  const person = member.role === "owner"
    ? people.find((x) => String(x.id) === p) ?? people.find((x) => x.id === member.personId)!
    : people.find((x) => x.id === member.personId)!;
  const data = getData();
  const photos = await getPhotoIndex();
  const now = new Date();
  const today = todayISO(now);
  const part = dayPart(localMinutes(now));
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
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

  // Morning routines: what the person chose, which fall on today's weekday, and whether each is ticked.
  const catalog = getRoutineCatalog(data);
  const options = catalogByHabit(catalog);
  const chosen = await getPersonRoutines(person.id);
  const chosenCount = chosen.filter((r) => r.active).length;
  const routineItems: RoutineItem[] = (await getTodayRoutines(person.id, today)).flatMap((r) => {
    const o = options.get(r.habitSlug);
    return o ? [{ habitSlug: r.habitSlug, title: o.title, line: summaryLine(o), timeOfDay: r.timeOfDay, done: r.done, soakHours: o.soakHours, grade: o.grade, evidenceNote: o.evidenceNote, caution: o.caution }] : [];
  });
  const layout = layoutFor(phase.kind, part, chosenCount > 0);

  // Daily basics for the chosen person. A habit that is now a routine is shown in the routine card, not twice.
  const { habits: allHabitRows, doneIds: done } = await getHabitsFor(today, person.id);
  const habitRows = withoutRoutineHabits(allHabitRows, catalog);
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
  const viewingYesterday = dayParam === yesterday;
  const focusDate = viewingYesterday ? yesterday : plannedDates.has(today) ? today : ([...plannedDates].filter((x) => x > today).sort()[0] ?? today);
  const isToday = focusDate === today;
  const canLog = focusDate <= today;
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
          image: photos.recipes.get(sl.recipeSlug) ?? null,
          thumbs: recipeThumbs(sl.recipeSlug, data.recipes, data.ingredients, photos.ingredients),
        };
      })
      .filter((m) => m.proteinG > 0 || m.kcal > 0);
  const baseMeals = mealsOn(focusDate);

  // Food log for the shown day: what each person ate, matched to the planned meals by person, date and slot.
  const planPeople = view?.people ?? [];
  const logPeople = [...new Map([...planPeople, person].map((x) => [x.id, x])).values()];
  const householdFoods = await getHouseholdFoodRows(true);
  const lookups = nutritionLookups(data.recipes, data.ingredients, householdFoods);
  const logRows = await getFoodEntries(logPeople.map((x) => x.id), focusDate, focusDate);
  const slotsOnDay = (view?.slots ?? []).filter((sl) => sl.date === focusDate);
  const plannedMeals = plannedMealsFrom(slotsOnDay.map((sl) => ({ id: sl.id, date: sl.date, slot: sl.slot, recipeSlug: sl.recipeSlug, servings: sl.servings })), logPeople.map((x) => x.id));
  const names = {
    recipe: (slug: string) => data.recipes.get(slug)?.name ?? slug,
    ingredient: (slug: string) => { const i = data.ingredients.get(slug); return i?.display_name ?? i?.name ?? slug; },
    food: (uid: string) => householdFoods.find((f) => f.uid === uid)?.name ?? "Food no longer available",
  };
  const myViews = entryViews(logRows.filter((r) => r.personId === person.id), lookups, names);
  const myBar = eatenBar({ personId: person.id, date: focusDate, today, meals: plannedMeals, rows: logRows.filter((r) => r.personId === person.id), lookups });
  const meals: MealView[] = baseMeals.map((m) => {
    const slotRow = slotsOnDay.find((sl) => sl.id === m.id);
    const a = mealAnswer({ personId: String(person.id), date: focusDate, slot: m.slot, recipe: m.slug }, myViews);
    return { ...m, log: { status: a.status, entryUid: a.entry?.uid ?? null, answerLabel: a.entry ? `${a.entry.name}${a.entry.amount ? ` (${a.entry.amount})` : ""}` : null, locked: slotRow?.locked ?? false } };
  });
  const chipPeople = people.filter((x) => member.role === "owner" || x.id === member.personId).map((x) => ({ id: x.id, name: x.name }));
  const dayLog: DayLog = {
    personId: person.id, date: focusDate, today, yesterday, canLog, isOwner: member.role === "owner", people: chipPeople, entries: myViews,
    status: myBar.status, pendingCount: myBar.pendingCount, dayWord: focusDate === today ? "today" : focusDate === yesterday ? "yesterday" : formatDay(focusDate).long,
  };
  const tomorrowFirst = mealsOn(tomorrow)[0];
  const preview = part === "evening" && tomorrowFirst ? { label: SLOT_LABEL[tomorrowFirst.slot] ?? tomorrowFirst.slot, name: tomorrowFirst.name } : null;

  // What each person's routines add on the focus day: its own line, never part of the protein bar.
  const routineChoices = (await Promise.all((view?.people ?? []).map(async (pp) => (await getPersonRoutines(pp.id)).filter((r) => r.active).map((r) => ({ habitSlug: r.habitSlug, days: r.days, servings: r.servings, personId: pp.id }))))).flat();
  const routineTotals = routineDayTotals(routineChoices, [focusDate], options, data.recipes, data.ingredients)[focusDate] ?? {};
  const bars: PersonBar[] = planPeople.map((pp) => {
    const planned = {
      id: pp.id,
      name: pp.name,
      proteinG: view?.days.find((x) => x.date === focusDate && Number(x.personId) === pp.id)?.proteinG ?? 0,
      targetG: proteinTargetOf(pp),
      routines: routineTotals[pp.id] ? { proteinG: routineTotals[pp.id]!.protein_g, kcal: routineTotals[pp.id]!.kcal } : null,
    };
    // A member reads only their own log, and a day that has not happened has nothing eaten: both keep the planned bar.
    if (!canLog || (member.role !== "owner" && pp.id !== member.personId)) return planned;
    const bar = eatenBar({ personId: pp.id, date: focusDate, today, meals: plannedMeals, rows: logRows.filter((r) => r.personId === pp.id), lookups });
    return { ...planned, eaten: { eatenG: bar.eaten ? bar.eaten.protein_g : null, pendingG: bar.pendingProteinG } };
  });

  const lastSet = await lastSetup();
  const setup: SetupSummary | undefined = lastSet ? { days: lastSet.days, mealTypes: lastSet.mealTypes.map((m) => SLOT_LABEL[m]?.toLowerCase() ?? m), people: lastSet.personIds.length } : undefined;
  const plans = await listPlans(5);
  const shopBy = view && phase.kind !== "no-plan" ? shopByDate(today, view.startDate, first?.dueDate, view.shoppingDay) : null;

  const latest = view ? await latestPlanMilestones() : null;
  const strip = view && latest && latest.planId === view.id && showNextSteps(phase.kind, latest.milestones) ? { planId: view.id, milestones: latest.milestones } : null;

  const planHasMeals = phase.kind === "mid-plan" || phase.kind === "last-two-days";
  const panels: Record<PanelId, ReactNode> = {
    hero: (
      <PhaseCard phase={phase} setup={setup}>
        {planHasMeals ? <ProteinBars people={bars} caption={canLog ? (isToday ? "Protein today" : "Protein yesterday") : isToday ? "Protein planned for today" : `Protein planned for ${formatDay(focusDate).long}`} /> : null}
      </PhaseCard>
    ),
    morning: <MorningRoutines key={`${person.id}-${today}-${part === "morning"}`} date={today} personId={person.id} items={routineItems} chosenCount={chosenCount} defaultOpen={part === "morning"} />,
    grocery: grocery ? <GroceryStatusCard progress={grocery} shopBy={shopBy} today={today} /> : null,
    meals: planHasMeals ? <MealsToday title={isToday ? "Today's meals" : `Meals on ${formatDay(focusDate).long}`} meals={meals} planId={view?.id} log={dayLog} /> : null,
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
  // Before a plan starts, or after it ends, food is still logged: show it on its own when the meals panel is not on the page.
  const logOnly = !planHasMeals && (myViews.length > 0 || viewingYesterday)
    ? <MealsToday title={isToday ? "Eaten today" : "Eaten yesterday"} meals={[]} planId={undefined} log={dayLog} />
    : null;
  const dayHref = (date?: string) => `/?${new URLSearchParams({ ...(p ? { p } : {}), ...(date ? { d: date } : {}) }).toString()}`;

  return (
    <FoodLogProvider>
      <PageTitle title="Today" sub={`${formatDay(today).long}. ${person.name}: ${proteinTargetOf(person)} g protein a day`} action={(
        <div className="flex flex-wrap justify-end gap-2">
          <AddFoodButton label="Add food" people={chipPeople} personId={person.id} today={today} yesterday={yesterday} isOwner={member.role === "owner"} {...(viewingYesterday ? { date: yesterday } : {})} />
          <LinkButton href="/plan/new" variant={phase.kind === "no-plan" ? "secondary" : "primary"}>New plan</LinkButton>
        </div>
      )} />
      <PersonSwitch people={chipPeople} activeId={person.id} />
      <DaySwitch viewingYesterday={viewingYesterday} yesterdayHref={dayHref(yesterday)} todayHref={dayHref()} />
      <div className="space-y-4 px-4 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          {strip ? <NextSteps planId={strip.planId} milestones={strip.milestones} /> : null}
          {render(layout.main)}
          {logOnly}
        </div>
        <aside aria-label="Shopping, basics and snacks" className="space-y-4">{render(layout.side)}</aside>
      </div>
    </FoodLogProvider>
  );
}
