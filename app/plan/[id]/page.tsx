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
import { getCandidates, getPlanRoutines, getPlanView, proteinTargetOf } from "@/lib/server/queries";
import { todayISO } from "@/lib/server/time";

export const metadata: Metadata = { title: "Your plan" };
export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const planId = Number(id);
  if (!Number.isInteger(planId)) notFound();
  const candidates = await getCandidates();
  const view = await getPlanView(planId, candidates);
  if (!view) notFound();
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const data = getData();

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
      image: data.recipes.get(s.recipeSlug)?.image ?? null,
      thumbs: recipeThumbs(s.recipeSlug, data.recipes, data.ingredients),
      dense: c?.nutrientDense ?? false,
      lowSugar: c?.lowSugar ?? false,
      light: c?.light ?? false,
      leftover: s.isLeftover ?? false,
      servingG: servingWeightG(s.recipeSlug, data.recipes, data.ingredients),
      unit: data.recipes.get(s.recipeSlug)?.serving_unit ?? null,
    };
  });
  const routineRows = planRoutineRows(await getPlanRoutines(planId), getRoutineCatalog(data));
  const sheet = await getPlanExport(planId);
  if (!sheet) notFound();
  const today = todayISO();
  const startIndex = Math.max(0, view.dates.indexOf(today));

  return (
    <PlanClient
      planId={planId}
      startIndex={startIndex}
      dates={view.dates.map((iso) => ({ iso, ...formatDay(iso), dayNum: iso.slice(8) }))}
      mealTypes={view.mealTypes}
      people={view.people.map((p) => ({ id: p.id, name: p.name, target: proteinTargetOf(p) }))}
      days={view.days.map((d) => ({ date: d.date, personId: Number(d.personId), proteinG: d.proteinG, kcal: d.kcal }))}
      slots={slots}
      sheet={sheet}
      routines={routineRows}
      allRecipes={candidates.map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, activeMin: c.activeMin, slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots] })).sort((a, b) => a.name.localeCompare(b.name))}
    />
  );
}
