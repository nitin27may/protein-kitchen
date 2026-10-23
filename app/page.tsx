import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { TodayCard } from "@/components/TodayCard";
import type { HabitView, PrepView, SnackView } from "@/components/TodayCard";
import { RecipeThumb } from "@/components/RecipeThumb";
import { Card, EmptyState, LinkButton, MacroLine, PageTitle, ProteinBar } from "@/components/ui";
import * as s from "@/lib/db/schema";
import { addDays, formatDay } from "@/lib/planner/dates";
import { getData, getDb } from "@/lib/server/context";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { SLOT_LABEL } from "@/lib/format";
import { loadNight, tonight } from "@/lib/server/prep";
import { getCandidates, getPlanView, latestPlanId, listPeople, listPlans, proteinTargetOf, toPersonTarget } from "@/lib/server/queries";
import { todayISO } from "@/lib/server/time";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const people = listPeople();
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
  const db = getDb();
  const data = getData();
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const planId = latestPlanId();
  const candidates = getCandidates();
  const view = planId ? getPlanView(planId, candidates) : undefined;

  const habitRows = db.select().from(s.habits).all();
  const logRows = db.select().from(s.habitLog).where(and(eq(s.habitLog.date, today), eq(s.habitLog.personId, person.id))).all();
  const done = new Set(logRows.filter((r) => r.done).map((r) => r.habitId));
  const habits: HabitView[] = habitRows.map((h) => ({
    slug: h.slug,
    title: h.title,
    grade: h.evidenceGrade as HabitView["grade"],
    note: h.evidenceNote,
    caution: h.caution,
    sourceUrl: h.sourceUrl,
    done: done.has(h.id),
    defaultOn: h.defaultOn && h.category !== "evening_prep_generic",
  })).filter((h) => h.defaultOn || habitRows.find((r) => r.slug === h.slug)?.category !== "evening_prep_generic");

  const prep: PrepView[] = tonight(view ? loadNight(view, today) : undefined, today).map((x) => ({ key: x.key, text: `${x.text}, for ${x.forName}`, done: x.done }));

  // Snack ideas by time available, protein-dense first.
  const target = toPersonTarget(person);
  const pool = candidates.filter((c) => c.mealSlots.includes("snack") && c.family !== "shakes" && c.perServing.protein_g >= 10 && ![...target.avoided].some((a) => c.ingredients.has(a)));
  const rank = (max: number): SnackView[] =>
    pool
      .filter((c) => c.activeMin <= max)
      .sort((a, b) => b.perServing.protein_g / b.perServing.kcal - a.perServing.protein_g / a.perServing.kcal)
      .slice(0, 3)
      .map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, kcal: c.perServing.kcal, minutes: c.activeMin, needsCooking: c.activeMin > 2 }));
  const snacks = { "0": rank(2), "5": rank(5), "10": rank(10) };

  const plans = listPlans(5);

  // Today's meals for this person, from the latest plan.
  const order = ["breakfast", "lunch", "dinner", "snack", "shake"];
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  // If nothing is planned for today, show the next planned day instead of an empty page.
  const plannedDates = new Set((view?.slots ?? []).map((sl) => sl.date));
  const focusDate = plannedDates.has(today) ? today : ([...plannedDates].filter((d) => d > today).sort()[0] ?? today);
  const isToday = focusDate === today;
  const focusLabel = isToday ? "today" : formatDay(focusDate).long;
  const todays = (view?.slots ?? [])
    .filter((sl) => sl.date === focusDate)
    .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot))
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
  const dayTotal = view?.days.find((d) => d.date === focusDate && Number(d.personId) === person.id);
  const proteinTarget = proteinTargetOf(person);
  const eaten = dayTotal?.proteinG ?? todays.reduce((a, m) => a + m.proteinG, 0);

  return (
    <>
      <PageTitle title="Today" sub={`${formatDay(today).long}. ${person.name}: ${proteinTarget} g protein a day`} action={<LinkButton href="/plan/new">New plan</LinkButton>} />
      {people.length > 1 ? (
        <nav className="flex gap-2 overflow-x-auto px-4 pb-2" aria-label="Person">
          {people.map((x) => (
            <Link key={x.id} href={`/?p=${x.id}`} aria-current={x.id === person.id ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-semibold transition-colors lg:min-h-9 ${x.id === person.id ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>{x.name}</Link>
          ))}
        </nav>
      ) : null}

      <div className="space-y-4 px-4 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Card className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-8">
            <div>
              <p className="text-sm text-muted">{isToday ? "Protein planned for today" : `Up next: ${focusLabel}`}</p>
              <p className="font-display text-6xl font-bold tabular-nums leading-none">{Math.round(eaten)}<span className="ml-2 text-lg font-medium text-muted">of {Math.round(proteinTarget)} g</span></p>
            </div>
            {view && todays.length ? <ProteinBar value={eaten} target={proteinTarget} label={isToday ? "Today's plan" : "Planned day"} /> : <p className="text-sm text-muted">{view ? "No meals planned for today in the current plan." : "Make a plan to see today's protein."}</p>}
          </Card>

          {todays.length ? (
            <section aria-labelledby="meals-today">
              <h2 id="meals-today" className="mb-2 text-lg font-semibold">{isToday ? "Today's meals" : `Meals on ${focusLabel}`}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {todays.map((m) => (
                  <li key={m.id}>
                    <Link href={`/recipes/${m.slug}`} className="flex h-full overflow-hidden rounded-card border border-line bg-surface hover:border-primary sm:flex-col">
                      <RecipeThumb image={m.image} thumbs={m.thumbs} label={SLOT_LABEL[m.slot] ?? m.slot} className="aspect-[4/3] w-28 shrink-0 sm:aspect-[16/9] sm:w-full" />
                      <div className="min-w-0 flex-1 p-3">
                        <p className="text-sm font-semibold text-primary">{SLOT_LABEL[m.slot] ?? m.slot}</p>
                        <p className="text-base font-semibold leading-snug">{m.name}</p>
                        <MacroLine protein={m.proteinG} kcal={m.kcal} minutes={m.leftover ? undefined : m.activeMin} />
                        {m.leftover ? <p className="mt-1 text-sm text-muted">Leftover, no cooking</p> : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : view ? null : (
            <EmptyState title="No plan yet" body="Choose days, meals and what you like, and the week is planned for you." action={<LinkButton href="/plan/new">Make a plan</LinkButton>} />
          )}
        </div>

        <aside aria-label="Today's checklist" className="space-y-4">
          <TodayCard
            date={today}
            dateLabel={formatDay(today).long}
            personId={person.id}
            personName={person.name}
            habits={habits}
            prep={prep}
            prepDate={tomorrow}
            snacks={snacks}
          />
          {view ? (
            <Card>
              <h2 className="text-lg font-semibold">Current plan</h2>
              <p className="text-sm text-muted">{formatDay(view.startDate).long} to {formatDay(view.endDate).long}, {view.dates.length} days</p>
              <LinkButton href={`/plan/${view.id}`} className="mt-3 w-full">Open plan</LinkButton>
            </Card>
          ) : null}
          {plans.length > 1 ? (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Earlier plans</h2>
              <ul className="divide-y divide-line">
                {plans.slice(1).map((pl) => (
                  <li key={pl.id}><Link href={`/plan/${pl.id}`} className="flex min-h-12 items-center justify-between text-base hover:text-primary">{formatDay(pl.startDate).long} to {formatDay(pl.endDate).short}<span className="text-sm font-semibold text-primary">Open</span></Link></li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}
