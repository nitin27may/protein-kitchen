import { buildPlanExport, type PlanExport } from "@/lib/export/model";
import { getData } from "./context";
import { getPlanView, proteinTargetOf } from "./queries";
import { todayISO } from "./time";

export function getPlanExport(planId: number): PlanExport | undefined {
  const view = getPlanView(planId);
  if (!view) return undefined;
  const data = getData();
  return buildPlanExport({
    startDate: view.startDate,
    endDate: view.endDate,
    generatedOn: todayISO(),
    people: view.people.map((p) => ({ id: p.id, name: p.name, proteinTargetG: proteinTargetOf(p), kcalTarget: p.kcalTarget ?? null })),
    slots: view.slots.map((s) => ({ date: s.date, slot: s.slot, recipeSlug: s.recipeSlug, servings: s.servings, isLeftover: s.isLeftover })),
    recipes: data.recipes,
    ingredients: data.ingredients,
    micros: data.micros,
  });
}
