import path from "node:path";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { backupBeforeReset, resetCounts, resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
let h: DbHandle;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const n = async (table: any): Promise<number> => Number((await h.db.select({ n: count() }).from(table))[0]!.n);

beforeEach(async () => {
  h = await openDb();
  await seedDatabase(h.db, data);
  const [person] = await h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id });
  const [setup] = await h.db.insert(s.planSetups).values({ personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
  const [plan] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
  const [recipe] = await h.db.select({ id: s.recipes.id }).from(s.recipes).limit(1);
  const [slot] = await h.db.insert(s.planSlots).values({ planId: plan!.id, date: "2026-11-02", slot: "lunch", recipeId: recipe!.id }).returning({ id: s.planSlots.id });
  await h.db.insert(s.planSlotPortions).values({ planSlotId: slot!.id, personId: person!.id, servings: 1 });
  await h.db.insert(s.groceryManual).values({ planId: plan!.id, text: "salt", checked: false });
  await h.db.update(s.recipeFeedback).set({ rating: 5, favourite: true, status: "tested" }).where(eq(s.recipeFeedback.recipeId, recipe!.id));
});

describe("resetData", () => {
  it("plans: removes plans and their lists, keeps people and ratings", async () => {
    await resetData(h.db, "plans");
    expect(await n(s.plans)).toBe(0);
    expect(await n(s.planSlots)).toBe(0);
    expect(await n(s.groceryManual)).toBe(0);
    expect(await n(s.people)).toBe(1);
    expect((await resetCounts(h.db)).ratings).toBe(1);
  });

  it("ratings: clears feedback to draft, keeps plans", async () => {
    await resetData(h.db, "ratings");
    expect((await resetCounts(h.db)).ratings).toBe(0);
    expect((await h.db.select().from(s.recipeFeedback)).every((r) => r.status === "draft" && r.rating === null && !r.favourite)).toBe(true);
    expect(await n(s.plans)).toBe(1);
  });

  it("profiles: removes people and the plans that need them, keeps ratings", async () => {
    await resetData(h.db, "profiles");
    expect(await n(s.people)).toBe(0);
    expect(await n(s.plans)).toBe(0);
    expect((await resetCounts(h.db)).ratings).toBe(1);
  });

  it("all: user data is gone and the library is untouched", async () => {
    await resetData(h.db, "all");
    expect(await resetCounts(h.db)).toEqual({ profiles: 0, plans: 0, groceryItems: 0, progressTicks: 0, ratings: 0, partChoices: 0, links: 0, routineChoices: 0, planRoutines: 0, planSteps: 0, photos: 0, foods: 0, foodLog: 0 });
    expect(await n(s.recipes)).toBe(data.recipes.size);
    expect(await n(s.ingredients)).toBe(data.ingredients.size);
    expect(await n(s.habits)).toBeGreaterThan(0);
  });

  it("refuses a destructive application reset until Postgres recovery is verified", async () => {
    await expect(backupBeforeReset()).rejects.toThrow("verified Postgres backup");
    expect(await n(s.plans)).toBe(1);
  });
});
