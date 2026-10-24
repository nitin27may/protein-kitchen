import path from "node:path";
import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { recipeIdBySlug, seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { perServing } from "../lib/nutrition/macros";
import { libraryVersion, verifyLibraryVersion } from "../lib/db/library-version";

const root = path.resolve(__dirname, "..");
let data: DataSet;
let handle: DbHandle;

beforeAll(async () => {
  data = loadData(root);
  handle = await openDb();
});

describe("seedDatabase", () => {
  it("loads every ingredient, recipe and technique", async () => {
    const report = await seedDatabase(handle.db, data);
    expect(report.ingredients).toBe(data.ingredients.size);
    expect(report.recipes).toBe(data.recipes.size);
    expect(report.techniques).toBe(data.techniques.size);
    expect(report.staleIngredients).toEqual([]);
    expect(report.staleRecipes).toEqual([]);
    const [ingCount] = await handle.db.select({ n: count() }).from(s.ingredients);
    expect(Number(ingCount?.n)).toBe(data.ingredients.size);
  });

  it("stores the same macros the library computes", async () => {
    const id = (await recipeIdBySlug(handle.db, "palak-paneer"))!;
    const [row] = await handle.db.select().from(s.recipeMacros).where(eq(s.recipeMacros.recipeId, id));
    const expected = perServing("palak-paneer", data.recipes, data.ingredients);
    expect(row!.proteinG).toBeCloseTo(expected.protein_g, 6);
    expect(row!.kcal).toBeCloseTo(expected.kcal, 6);
    expect(row!.autoTags).toContain("high-protein");
  });

  it("records anchor ingredients", async () => {
    const id = (await recipeIdBySlug(handle.db, "palak-paneer"))!;
    const rows = await handle.db
      .select({ slug: s.ingredients.slug })
      .from(s.recipeAnchors)
      .innerJoin(s.ingredients, eq(s.ingredients.id, s.recipeAnchors.ingredientId))
      .where(eq(s.recipeAnchors.recipeId, id));
    expect(rows.map((r) => r.slug)).toContain("paneer");
  });

  it("resolves component references to recipe ids", async () => {
    const id = (await recipeIdBySlug(handle.db, "mediterranean-chickpea-salad"))!;
    const items = await handle.db.select().from(s.recipeItems).where(eq(s.recipeItems.recipeId, id));
    expect(items.some((i) => i.componentId !== null)).toBe(true);
    expect(items.every((i) => (i.ingredientId === null) !== (i.componentId === null))).toBe(true);
  });

  it("keeps human feedback and people when reseeding", async () => {
    const id = (await recipeIdBySlug(handle.db, "dal-tadka"))!;
    await handle.db.update(s.recipeFeedback).set({ status: "tested", rating: 4, favourite: true }).where(eq(s.recipeFeedback.recipeId, id));
    await handle.db
      .insert(s.people)
      .values({ name: "Test", sex: "male", birthDate: "1986-04-10", heightCm: 183, weightKg: 93, activityLevel: "moderate", proteinGPerKg: 1.3, dietFlags: [] });

    await seedDatabase(handle.db, data);

    const [fb] = await handle.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, id));
    expect(fb).toMatchObject({ status: "tested", rating: 4, favourite: true });
    const [people] = await handle.db.select({ n: count() }).from(s.people);
    const [recipes] = await handle.db.select({ n: count() }).from(s.recipes);
    expect(Number(people?.n)).toBe(1);
    expect(Number(recipes?.n)).toBe(data.recipes.size);
  });

  it("enforces foreign keys", async () => {
    await expect(handle.db.insert(s.recipeSteps).values({ recipeId: 999999, stepNo: 1, text: "x" })).rejects.toThrow();
  });

  it("refuses mismatched content without changing it or silently seeding", async () => {
    await verifyLibraryVersion(handle.db, data);
    const recipes = new Map(data.recipes);
    const [slug, recipe] = [...recipes][0]!;
    recipes.set(slug, { ...recipe, name: `${recipe.name} changed` });
    const changed = { ...data, recipes };
    await expect(verifyLibraryVersion(handle.db, changed)).rejects.toThrow("out of date");
    expect(await handle.db.select().from(s.libraryState)).toEqual([{ key: "library", version: libraryVersion(data) }]);
  });

  it("rolls back all content and the version marker if a later seed write fails", async () => {
    const recipes = new Map(data.recipes);
    const [slug, recipe] = [...recipes][0]!;
    recipes.set(slug, { ...recipe, name: `${recipe.name} changed` });
    await handle.failWrite("recipe_steps", "insert", "fail_seed");
    await expect(seedDatabase(handle.db, { ...data, recipes })).rejects.toThrow();
    expect(await handle.db.select({ name: s.recipes.name }).from(s.recipes).where(eq(s.recipes.slug, slug))).toEqual([{ name: recipe.name }]);
    await verifyLibraryVersion(handle.db, data);
    await handle.dropFailure("recipe_steps", "fail_seed");
  });
});
