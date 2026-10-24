import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { PLAN_STEPS } from "../planner/feasibility-types";
import type { PlanMilestones, PlanStep } from "../planner/feasibility-types";

/** Relative imports only, so tests can run this against an in-memory database. */

export type StepWrite = { ok: true } | { ok: false; error: string };

export function isPlanStep(value: unknown): value is PlanStep {
  return typeof value === "string" && (PLAN_STEPS as readonly string[]).includes(value);
}

/** Which after-plan steps are done. Every step is always present in the result. */
export async function readPlanMilestones(db: Db, planId: number): Promise<PlanMilestones> {
  const rows = await db.select({ step: s.planProgress.step }).from(s.planProgress).where(eq(s.planProgress.planId, planId));
  const done = new Set(rows.map((r) => r.step));
  return Object.fromEntries(PLAN_STEPS.map((step) => [step, done.has(step)])) as PlanMilestones;
}

/** Marks a step done. Doing it again keeps the first time. */
export async function writePlanStep(db: Db, planId: number, step: unknown): Promise<StepWrite> {
  if (!isPlanStep(step)) return { ok: false, error: "Unknown step" };
  const [plan] = await db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.id, planId)).limit(1);
  if (!plan) return { ok: false, error: "Plan not found" };
  await db.insert(s.planProgress).values({ planId, step, doneAt: new Date().toISOString() }).onConflictDoNothing();
  return { ok: true };
}
