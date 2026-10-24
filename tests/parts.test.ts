import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { buildGroceryList, expandRecipe } from "../lib/grocery/aggregate";
import { partIsMade, resolverFor } from "../lib/parts/resolve";
import { buildNight, nightTasks } from "../lib/prep/night";
import { groceryProgressFrom } from "../lib/plan/phase";
import { readPartModes, writePartMode } from "../lib/server/part-state";
import { resetCounts, resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
let h: DbHandle;
let planId = 0;

const bowl = [{ recipeSlug: "falafel-bowl", servings: 2 }];
const grams = (lines: { ingredient: string; grams: number }[]) => new Map(lines.map((l) => [l.ingredient, l.grams]));

beforeAll(() => {
  // The tests below lean on this recipe shape; fail loudly if the data changes under them.
  const r = data.recipes.get("falafel-bowl")!;
  expect(r.servings).toBe(2);
  expect(r.items.some((i) => "component" in i && i.component === "hummus" && i.alt_ingredient === "hummus-commercial")).toBe(true);
});

beforeEach(async () => {
  h = await openDb();
  await seedDatabase(h.db, data);
  const [person] = await h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id });
  const [setup] = await h.db.insert(s.planSetups).values({ personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
  const [plan] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
  planId = plan!.id;
});

describe("saving part modes", () => {
  it("saves, changes and removes a choice, and make is the default", async () => {
    expect(await readPartModes(h.db, planId)).toEqual({});
    expect(await writePartMode(h.db, data.recipes, planId, "hummus", "have")).toEqual({ ok: true });
    expect(await readPartModes(h.db, planId)).toEqual({ hummus: "have" });
    expect(await writePartMode(h.db, data.recipes, planId, "hummus", "buy")).toEqual({ ok: true });
    expect(await readPartModes(h.db, planId)).toEqual({ hummus: "buy" });
    expect(await h.db.select().from(s.planPartState)).toHaveLength(1);
    expect(await writePartMode(h.db, data.recipes, planId, "hummus", "make")).toEqual({ ok: true });
    expect(await readPartModes(h.db, planId)).toEqual({});
    expect(await h.db.select().from(s.planPartState)).toHaveLength(0);
  });

  it("keeps choices separate per plan and per part", async () => {
    const [setup] = await h.db.insert(s.planSetups).values({ personIds: [1], startDate: "2026-11-09", endDate: "2026-11-15", mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
    const [other] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 2, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
    await writePartMode(h.db, data.recipes, planId, "hummus", "have");
    await writePartMode(h.db, data.recipes, planId, "lemon-tahini-dressing", "buy");
    await writePartMode(h.db, data.recipes, other!.id, "hummus", "buy");
    expect(await readPartModes(h.db, planId)).toEqual({ hummus: "have", "lemon-tahini-dressing": "buy" });
    expect(await readPartModes(h.db, other!.id)).toEqual({ hummus: "buy" });
  });

  it("rejects an unknown plan, an unknown part, a recipe that is not a part, and a bad mode", async () => {
    expect(await writePartMode(h.db, data.recipes, 9999, "hummus", "have")).toMatchObject({ ok: false, error: "Plan not found" });
    expect(await writePartMode(h.db, data.recipes, planId, "no-such-part", "have")).toMatchObject({ ok: false, error: "That part was not found" });
    expect(await writePartMode(h.db, data.recipes, planId, "falafel-bowl", "have")).toMatchObject({ ok: false, error: "That part was not found" });
    expect(await writePartMode(h.db, data.recipes, planId, "hummus", "steal")).toMatchObject({ ok: false, error: "Choose make, buy or have" });
    expect(await h.db.select().from(s.planPartState)).toHaveLength(0);
  });

  it("the database refuses a mode outside make, buy and have", async () => {
    await expect(h.db.insert(s.planPartState).values({ planId, componentSlug: "hummus", mode: "steal", updatedAt: "2026-11-01T00:00:00.000Z" })).rejects.toThrow();
  });

  it("deleting a plan deletes its part choices", async () => {
    await writePartMode(h.db, data.recipes, planId, "hummus", "have");
    await h.db.delete(s.plans).where(eq(s.plans.id, planId));
    expect(await h.db.select().from(s.planPartState)).toHaveLength(0);
  });
});

describe("part helpers", () => {
  it("builds a resolver only when there is something to resolve", () => {
    expect(resolverFor(undefined)).toBeUndefined();
    expect(resolverFor({})).toBeUndefined();
    expect(resolverFor({ hummus: "have" })?.("hummus")).toBe("have");
    expect(resolverFor({ hummus: "have" })?.("other")).toBeUndefined();
  });
  it("a part is cooked unless it is had, or bought with a ready-made alternative", () => {
    expect(partIsMade(undefined, false)).toBe(true);
    expect(partIsMade("make", true)).toBe(true);
    expect(partIsMade("have", false)).toBe(false);
    expect(partIsMade("have", true)).toBe(false);
    expect(partIsMade("buy", true)).toBe(false);
    expect(partIsMade("buy", false)).toBe(true);
  });
});

describe("grocery list with part modes", () => {
  const base = buildGroceryList(bowl, data.recipes, data.ingredients);

  it("is identical to before when no modes are given or every part is made", () => {
    expect(buildGroceryList(bowl, data.recipes, data.ingredients, undefined)).toEqual(base);
    expect(buildGroceryList(bowl, data.recipes, data.ingredients, {})).toEqual(base);
    expect(buildGroceryList(bowl, data.recipes, data.ingredients, { hummus: "make" })).toEqual(base);
  });

  it("have: leaves out exactly what the hummus needed, and adds nothing", () => {
    const item = data.recipes.get("falafel-bowl")!.items.find((i) => "component" in i && i.component === "hummus")!;
    const hummus = data.recipes.get("hummus")!;
    const yieldG = hummus.items.reduce((a, b) => a + b.grams, 0);
    const share = expandRecipe("hummus", (item.grams * hummus.servings) / yieldG, data.recipes);
    const have = grams(buildGroceryList(bowl, data.recipes, data.ingredients, { hummus: "have" }).lines);
    const before = grams(base.lines);
    expect(have.has("hummus-commercial")).toBe(false);
    for (const [k, g] of share) {
      if (k === "water-tap") continue;
      expect(have.get(k) ?? 0).toBeCloseTo((before.get(k) ?? 0) - g, 6);
    }
    expect([...share.keys()].some((k) => k !== "water-tap" && (have.get(k) ?? 0) < (before.get(k) ?? 0))).toBe(true);
  });

  it("buy: swaps in the ready-made hummus at the same grams", () => {
    const item = data.recipes.get("falafel-bowl")!.items.find((i) => "component" in i && i.component === "hummus")!;
    const buy = buildGroceryList(bowl, data.recipes, data.ingredients, { hummus: "buy" });
    const have = grams(buildGroceryList(bowl, data.recipes, data.ingredients, { hummus: "have" }).lines);
    const bought = buy.lines.find((l) => l.ingredient === "hummus-commercial");
    expect(bought?.grams).toBeCloseTo(item.grams, 6);
    // Apart from the ready-made hummus, buying leaves the same list as already having it.
    const rest = grams(buy.lines.filter((l) => l.ingredient !== "hummus-commercial"));
    expect([...rest]).toEqual([...have]);
  });

  it("buy on a part with no ready-made alternative falls back to making it", () => {
    expect(buildGroceryList(bowl, data.recipes, data.ingredients, { "baked-falafel": "buy" })).toEqual(base);
  });

  it("scales with servings and sums across meals", () => {
    const meals = [{ recipeSlug: "falafel-bowl", servings: 2 }, { recipeSlug: "falafel-bowl", servings: 4 }];
    const buy = buildGroceryList(meals, data.recipes, data.ingredients, { hummus: "buy" });
    expect(buy.lines.find((l) => l.ingredient === "hummus-commercial")?.grams).toBeCloseTo(180, 6);
  });

  it("Today's progress count follows the same modes", () => {
    const none = groceryProgressFrom(bowl, data.recipes, data.ingredients, new Set());
    const have = groceryProgressFrom(bowl, data.recipes, data.ingredients, new Set(), { "baked-falafel": "have", hummus: "have", "lemon-tahini-dressing": "have" });
    expect(none.left).toBe(none.total);
    expect(have.total).toBeLessThan(none.total);
    expect(have.left).toBe(have.total);
  });
});

describe("night-before tasks with part modes", () => {
  const meals = [{ date: "2026-11-03", slot: "dinner", recipeSlug: "falafel-bowl", servings: 2 }];
  const input = (partModes?: Record<string, "make" | "buy" | "have">) => ({ planId, meals, recipes: data.recipes, earliest: "2026-10-20", partModes });
  const soakFor = (tasks: ReturnType<typeof nightTasks>) => tasks.filter((t) => t.slug === "baked-falafel");

  it("asks for the chickpea soak when the falafel is made", () => {
    expect(soakFor(nightTasks(input())).length).toBeGreaterThan(0);
    expect(soakFor(nightTasks(input({ "baked-falafel": "make" }))).length).toBeGreaterThan(0);
  });

  it("has no soak and no cook event when the falafel is already in the fridge", () => {
    const night = buildNight(input({ "baked-falafel": "have" }));
    expect(soakFor(night.tasks)).toHaveLength(0);
    expect(night.guide.events.some((e) => e.slug === "baked-falafel")).toBe(false);
  });

  it("a buy without a ready-made alternative still cooks the part", () => {
    expect(soakFor(nightTasks(input({ "baked-falafel": "buy" }))).length).toBeGreaterThan(0);
  });

  it("changing another part leaves task keys for the rest unchanged", () => {
    const keys = (t: ReturnType<typeof nightTasks>) => t.map((x) => x.key);
    expect(keys(nightTasks(input({ hummus: "have" })))).toEqual(keys(nightTasks(input())));
  });
});

describe("resetting plans", () => {
  it("deletes part choices with the plans and counts them", async () => {
    await writePartMode(h.db, data.recipes, planId, "hummus", "have");
    await writePartMode(h.db, data.recipes, planId, "baked-falafel", "have");
    expect(await resetCounts(h.db)).toMatchObject({ plans: 1, partChoices: 2 });
    await resetData(h.db, "plans");
    expect(await h.db.select().from(s.planPartState)).toHaveLength(0);
    expect(await resetCounts(h.db)).toMatchObject({ plans: 0, partChoices: 0 });
  });

  it("everything reset removes them too", async () => {
    await writePartMode(h.db, data.recipes, planId, "hummus", "buy");
    await resetData(h.db, "all");
    expect(await h.db.select().from(s.planPartState)).toHaveLength(0);
  });
});
