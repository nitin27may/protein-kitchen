import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";
import { PLAN_STEPS } from "../lib/planner/feasibility-types";
import { readPlanMilestones, writePlanStep } from "../lib/server/plan-progress";
import { insertPlanSetup } from "../lib/server/plan-setup";
import { resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
let h: DbHandle;
let planId = 0;

const base = {
  personIds: [1],
  startDate: "2026-11-02",
  endDate: "2026-11-08",
  mealTypes: ["dinner"],
  cuisineBalance: 0.5,
  maxActiveMin: null,
  healthFocus: { nutrientDense: true, lowSugar: true, light: true },
  prepStyle: "leftovers" as const,
  createdAt: "2026-11-01",
};

async function makePlan(over: Partial<Parameters<typeof insertPlanSetup>[1]> = {}): Promise<number> {
  return withTx(h.db, (tx) => {
    const setupId = insertPlanSetup(tx, { ...base, ...over });
    return tx.insert(s.plans).values({ setupId, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id }).get().id;
  });
}

beforeEach(async () => {
  h = openDb(":memory:", path.join(root, "db", "migrations"));
  await seedDatabase(h.db, data);
  await h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] });
  planId = await makePlan();
});

describe("plan milestones", () => {
  it("starts with all three steps not done, in the fixed key set", async () => {
    const m = await readPlanMilestones(h.db, planId);
    expect(Object.keys(m).sort()).toEqual([...PLAN_STEPS].sort());
    expect(Object.values(m)).toEqual([false, false, false]);
  });

  it("marks a step done and leaves the others alone", async () => {
    expect(await writePlanStep(h.db, planId, "shopping")).toEqual({ ok: true });
    expect(await readPlanMilestones(h.db, planId)).toEqual({ reviewed: false, shopping: true, prep: false });
  });

  it("is idempotent and keeps the first time", async () => {
    await writePlanStep(h.db, planId, "reviewed");
    const [first] = await h.db.select().from(s.planProgress).where(eq(s.planProgress.planId, planId));
    await new Promise((r) => setTimeout(r, 5));
    expect(await writePlanStep(h.db, planId, "reviewed")).toEqual({ ok: true });
    const rows = await h.db.select().from(s.planProgress).where(eq(s.planProgress.planId, planId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doneAt).toBe(first!.doneAt);
  });

  it("rejects an unknown step and an unknown plan, and writes nothing", async () => {
    expect(await writePlanStep(h.db, planId, "cooking")).toEqual({ ok: false, error: "Unknown step" });
    expect(await writePlanStep(h.db, planId, undefined)).toEqual({ ok: false, error: "Unknown step" });
    expect(await writePlanStep(h.db, 9999, "reviewed")).toEqual({ ok: false, error: "Plan not found" });
    expect(await h.db.select().from(s.planProgress)).toHaveLength(0);
  });

  it("the database itself refuses a step outside the allowed three", () => {
    expect(() => h.sqlite.prepare("insert into plan_progress (plan_id, step, done_at) values (?, 'cooking', 'x')").run(planId)).toThrow();
  });

  it("keeps each plan's progress separate", async () => {
    const other = await makePlan();
    await writePlanStep(h.db, planId, "prep");
    expect((await readPlanMilestones(h.db, other)).prep).toBe(false);
    expect((await readPlanMilestones(h.db, planId)).prep).toBe(true);
  });

  it("is deleted with its plan", async () => {
    await writePlanStep(h.db, planId, "reviewed");
    await h.db.delete(s.plans).where(eq(s.plans.id, planId));
    expect(await h.db.select().from(s.planProgress)).toHaveLength(0);
  });

  it("is cleared by the plans reset", async () => {
    await writePlanStep(h.db, planId, "reviewed");
    await resetData(h.db, "plans");
    expect(await h.db.select().from(s.planProgress)).toHaveLength(0);
  });

  it("is not cleared by the ratings reset", async () => {
    await writePlanStep(h.db, planId, "reviewed");
    await resetData(h.db, "ratings");
    expect(await h.db.select().from(s.planProgress)).toHaveLength(1);
  });
});

describe("storing the shopping and prep days", () => {
  const stored = async (id: number) => {
    const [row] = await h.db.select({ shop: s.planSetups.shoppingDay, prep: s.planSetups.prepDay }).from(s.plans).innerJoin(s.planSetups, eq(s.planSetups.id, s.plans.setupId)).where(eq(s.plans.id, id));
    return row!;
  };

  it("stores weekdays 1 to 7", async () => {
    expect(await stored(await makePlan({ shoppingDay: 6, prepDay: 7 }))).toEqual({ shop: 6, prep: 7 });
    expect(await stored(await makePlan({ shoppingDay: 1, prepDay: 1 }))).toEqual({ shop: 1, prep: 1 });
  });

  it("stores none when nothing was chosen, and for any value that is not a weekday", async () => {
    expect(await stored(planId)).toEqual({ shop: null, prep: null });
    expect(await stored(await makePlan({ shoppingDay: null, prepDay: null }))).toEqual({ shop: null, prep: null });
    expect(await stored(await makePlan({ shoppingDay: 0, prepDay: 8 }))).toEqual({ shop: null, prep: null });
    expect(await stored(await makePlan({ shoppingDay: 2.5, prepDay: -1 }))).toEqual({ shop: null, prep: null });
  });
});
