import { buildNight } from "@/lib/prep/night";
import { effectivePrepDay } from "@/lib/prep/session";
import type { PlanExport } from "@/lib/export/model";
import type { SchedulePrepTask } from "@/lib/export/schedule-model";
import { getData } from "./context";
import { getPlanExport } from "./export";
import { mealsOf } from "./prep";
import { getPartModes, getPlanView, routineContext } from "./queries";

export interface ScheduleData {
  plan: PlanExport;
  prep: SchedulePrepTask[];
}

/**
 * The plan and its night-before tasks for the fridge sheet. Read-only: unlike the prep page it does not rewrite saved
 * ticks. Household scoping comes from getPlanView, so another household's plan is simply not found.
 */
export async function getScheduleData(planId: number): Promise<ScheduleData | undefined> {
  const view = await getPlanView(planId);
  if (!view) return undefined;
  const plan = await getPlanExport(planId);
  if (!plan) return undefined;
  const { tasks } = buildNight({
    planId: view.id,
    meals: mealsOf(view),
    recipes: getData().recipes,
    earliest: view.startDate,
    partModes: await getPartModes(view.id),
    prepDay: effectivePrepDay(view.prepDay, view.input.prepStyle),
    routines: (await routineContext(view)).inputs,
  });
  return { plan, prep: tasks.map((t) => ({ dueDate: t.dueDate, text: t.text, forName: t.forName })) };
}
