import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import { recipeIdBySlug, seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { perServing } from "../lib/nutrition/macros";

const root = path.resolve(__dirname, "..");
let data: DataSet;
let handle: DbHandle;

beforeAll(() => {
  data = loadData(root);
  handle = openDb(":memory:", path.join(root, "db", "migrations"));
});

describe("seedDatabase", () => {
  it("loads every ingredient, recipe and technique", () => {
    const report = seedDatabase(handle.db, data);
    expect(report.ingredients).toBe(data.ingredients.size);
    expect(report.recipes).toBe(data.recipes.size);
    expect(report.techniques).toBe(data.techniques.size);
    expect(report.staleIngredients).toEqual([]);
    expect(report.staleRecipes).toEqual([]);
    const count = handle.db.select({ n: sql<number>`count(*)` }).from(s.ingredients).get()?.n;
    expect(count).toBe(data.ingredients.size);
  });

  it("stores the same macros the library computes", () => {
    const id = recipeIdBySlug(handle.db, "palak-paneer")!;
    const row = handle.db.select().from(s.recipeMacros).where(eq(s.recipeMacros.recipeId, id)).get()!;
    const expected = perServing("palak-paneer", data.recipes, data.ingredients);
    expect(row.proteinG).toBeCloseTo(expected.protein_g, 6);
    expect(row.kcal).toBeCloseTo(expected.kcal, 6);
    expect(row.autoTags).toContain("high-protein");
  });

  it("records anchor ingredients", () => {
    const id = recipeIdBySlug(handle.db, "palak-paneer")!;
    const rows = handle.db
      .select({ slug: s.ingredients.slug })
      .from(s.recipeAnchors)
      .innerJoin(s.ingredients, eq(s.ingredients.id, s.recipeAnchors.ingredientId))
      .where(eq(s.recipeAnchors.recipeId, id))
      .all();
    expect(rows.map((r) => r.slug)).toContain("paneer");
  });

  it("resolves component references to recipe ids", () => {
    const id = recipeIdBySlug(handle.db, "mediterranean-chickpea-salad")!;
    const items = handle.db.select().from(s.recipeItems).where(eq(s.recipeItems.recipeId, id)).all();
    expect(items.some((i) => i.componentId !== null)).toBe(true);
    expect(items.every((i) => (i.ingredientId === null) !== (i.componentId === null))).toBe(true);
  });

  it("keeps human feedback and people when reseeding", () => {
    const id = recipeIdBySlug(handle.db, "dal-tadka")!;
    handle.db.update(s.recipeFeedback).set({ status: "tested", rating: 4, favourite: true }).where(eq(s.recipeFeedback.recipeId, id)).run();
    handle.db
      .insert(s.people)
      .values({ name: "Test", sex: "male", birthDate: "1986-04-10", heightCm: 183, weightKg: 93, activityLevel: "moderate", proteinGPerKg: 1.3, dietFlags: [] })
      .run();

    seedDatabase(handle.db, data);

    const fb = handle.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, id)).get()!;
    expect(fb).toMatchObject({ status: "tested", rating: 4, favourite: true });
    expect(handle.db.select({ n: sql<number>`count(*)` }).from(s.people).get()?.n).toBe(1);
    expect(handle.db.select({ n: sql<number>`count(*)` }).from(s.recipes).get()?.n).toBe(data.recipes.size);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      handle.sqlite.prepare("INSERT INTO recipe_steps (recipe_id, step_no, text) VALUES (999999, 1, 'x')").run(),
    ).toThrow();
  });
});
