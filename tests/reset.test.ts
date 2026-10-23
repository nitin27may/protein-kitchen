import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { backupBeforeReset, resetCounts, resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
let h: DbHandle;

const n = (table: Parameters<typeof h.db.select>[0] extends never ? never : any) => h.db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;

beforeEach(() => {
  h = openDb(":memory:", path.join(root, "db", "migrations"));
  seedDatabase(h.db, data);
  const person = h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id }).get();
  const setup = h.db.insert(s.planSetups).values({ personIds: [person.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id }).get();
  const plan = h.db.insert(s.plans).values({ setupId: setup.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id }).get();
  const recipe = h.db.select({ id: s.recipes.id }).from(s.recipes).limit(1).get()!;
  const slot = h.db.insert(s.planSlots).values({ planId: plan.id, date: "2026-11-02", slot: "lunch", recipeId: recipe.id }).returning({ id: s.planSlots.id }).get();
  h.db.insert(s.planSlotPortions).values({ planSlotId: slot.id, personId: person.id, servings: 1 }).run();
  h.db.insert(s.groceryManual).values({ planId: plan.id, text: "salt", checked: false }).run();
  h.db.update(s.recipeFeedback).set({ rating: 5, favourite: true, status: "tested" }).where(eq(s.recipeFeedback.recipeId, recipe.id)).run();
});

describe("resetData", () => {
  it("plans: removes plans and their lists, keeps people and ratings", () => {
    resetData(h.db, "plans");
    expect(n(s.plans)).toBe(0);
    expect(n(s.planSlots)).toBe(0);
    expect(n(s.groceryManual)).toBe(0);
    expect(n(s.people)).toBe(1);
    expect(resetCounts(h.db).ratings).toBe(1);
  });

  it("ratings: clears feedback to draft, keeps plans", () => {
    resetData(h.db, "ratings");
    expect(resetCounts(h.db).ratings).toBe(0);
    expect(h.db.select().from(s.recipeFeedback).all().every((r) => r.status === "draft" && r.rating === null && !r.favourite)).toBe(true);
    expect(n(s.plans)).toBe(1);
  });

  it("profiles: removes people and the plans that need them, keeps ratings", () => {
    resetData(h.db, "profiles");
    expect(n(s.people)).toBe(0);
    expect(n(s.plans)).toBe(0);
    expect(resetCounts(h.db).ratings).toBe(1);
  });

  it("all: user data is gone and the library is untouched", () => {
    resetData(h.db, "all");
    expect(resetCounts(h.db)).toEqual({ profiles: 0, plans: 0, groceryItems: 0, progressTicks: 0, ratings: 0 });
    expect(n(s.recipes)).toBe(data.recipes.size);
    expect(n(s.ingredients)).toBe(data.ingredients.size);
    expect(n(s.habits)).toBeGreaterThan(0);
  });

  it("does not write a backup for an in-memory database", () => {
    expect(backupBeforeReset(h.sqlite, root, "all")).toBeNull();
  });
});
