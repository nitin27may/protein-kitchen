import { requirePageMember } from "@/lib/auth/access";
import { servingWeightG } from "@/lib/nutrition/portion";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlanClient } from "@/components/PlanClient";
import type { PlanSlotView } from "@/components/PlanClient";
import { formatDay } from "@/lib/planner/dates";
import { getRoutineCatalog } from "@/lib/routines/catalog";
import { planRoutineRows } from "@/lib/routines/view";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { getData } from "@/lib/server/context";
import { getPlanExport } from "@/lib/server/export";
import { getCandidates, getPlanMilestones, getPlanRoutines, getPlanView, proteinTargetOf } from "@/lib/server/queries";
import { todayISO } from "@/lib/server/time";
import { getPhotoIndex } from "@/lib/server/queries";
import { reviewPlan } from "@/lib/food-log/day-view";
import { plannedMealsFrom } from "@/lib/food-log/keys";
import { nutritionLookups } from "@/lib/food-log/lookups";
import { getFoodEntries, getHouseholdFoodRows } from "@/lib/server/food-log-queries";

export const metadata: Metadata = { title: "Your plan" };
export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePageMember();
  const { id } = await params;
  const planId = Number(id);
  if (!Number.isInteger(planId)) notFound();
  const view = await getPlanView(planId);
  if (!view) notFound();
  const candidates = await getCandidates(view.people.map((p) => p.id));
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const data = getData();
  const photos = await getPhotoIndex();

  const slots: PlanSlotView[] = view.slots.map((s) => {
    const c = byslug.get(s.recipeSlug);
    return {
      id: s.id,
      date: s.date,
      slot: s.slot,
      recipeSlug: s.recipeSlug,
      recipeName: c?.name ?? s.recipeSlug,
      proteinG: c?.perServing.protein_g ?? 0,
      kcal: c?.perServing.kcal ?? 0,
      activeMin: c?.activeMin ?? 0,
      locked: s.locked,
      servings: s.servings,
      image: photos.recipes.get(s.recipeSlug) ?? null,
      thumbs: recipeThumbs(s.recipeSlug, data.recipes, data.ingredients, photos.ingredients),
      dense: c?.nutrientDense ?? false,
      lowSugar: c?.lowSugar ?? false,
      light: c?.light ?? false,
      leftover: s.isLeftover ?? false,
      servingG: servingWeightG(s.recipeSlug, data.recipes, data.ingredients),
      unit: data.recipes.get(s.recipeSlug)?.serving_unit ?? null,
    };
  });
  // Each recipe's make-ahead work is done once, however many slots use it. Parts set to Have or Buy are not subtracted.
  const makeAheadWeekMin = [...new Set(view.slots.map((s) => s.recipeSlug))].reduce((sum, slug) => sum + (byslug.get(slug)?.makeAheadMin ?? 0), 0);
  const routineRows = planRoutineRows(await getPlanRoutines(planId), getRoutineCatalog(data));
  const sheet = await getPlanExport(planId);
  if (!sheet) notFound();
  const today = todayISO();
  const startIndex = Math.max(0, view.dates.indexOf(today));

  // Eaten against planned. An owner reviews everyone in the plan; a member reviews only their own log.
  const reviewed = view.people.filter((x) => member.role === "owner" || x.id === member.personId);
  const reviewedIds = reviewed.map((x) => x.id);
  const meals = plannedMealsFrom(view.slots.map((sl) => ({ id: sl.id, date: sl.date, slot: sl.slot, recipeSlug: sl.recipeSlug, servings: sl.servings })), reviewedIds);
  const lookups = nutritionLookups(data.recipes, data.ingredients, await getHouseholdFoodRows(true));
  const eaten = reviewPlan({
    people: reviewed.map((x) => ({ id: x.id, name: x.name, targetG: proteinTargetOf(x) })), dates: view.dates, today, meals,
    rows: await getFoodEntries(reviewedIds, view.startDate, view.endDate), lookups,
  });

  return (
    <PlanClient
      planId={planId}
      startIndex={startIndex}
      dates={view.dates.map((iso) => ({ iso, ...formatDay(iso), dayNum: iso.slice(8) }))}
      mealTypes={view.mealTypes}
      people={view.people.map((p) => ({ id: p.id, name: p.name, target: proteinTargetOf(p) }))}
      days={view.days.map((d) => ({ date: d.date, personId: Number(d.personId), proteinG: d.proteinG, kcal: d.kcal }))}
      slots={slots}
      makeAheadWeekMin={makeAheadWeekMin}
      sheet={sheet}
      routines={routineRows}
      milestones={await getPlanMilestones(planId)}
      eaten={eaten}
      allRecipes={candidates.map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, activeMin: c.activeMin, slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots] })).sort((a, b) => a.name.localeCompare(b.name))}
    />
  );
}
