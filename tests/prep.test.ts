import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { buildCandidates } from "../lib/planner/candidates";
import { generatePlan } from "../lib/planner/generate";
import { datesBetween } from "../lib/planner/dates";
import { buildPrepGuide } from "../lib/prep/session";
import type { MealRef } from "../lib/prep/session";
import type { Recipe } from "../lib/schemas";

const recipe = (slug: string, over: Partial<Recipe> = {}): Recipe => ({
  slug,
  name: slug,
  kind: "recipe",
  family: "curries",
  meal_slots: ["dinner"],
  cuisine: "indian",
  is_indian: true,
  servings: 2,
  prep_min: 5,
  active_min: 20,
  total_min: 50,
  equipment: ["stove"],
  tags: [],
  fridge_days: 4,
  status: "draft",
  items: [{ ingredient: "x", grams: 100 }],
  advance_prep: [],
  steps: [{ text: "cook" }],
  ...over,
});

const index = (rs: Recipe[]) => new Map(rs.map((r) => [r.slug, r]));
const meal = (date: string, slug: string, servings = 2, slot = "dinner"): MealRef => ({ date, slot, recipeSlug: slug, servings });
const SUN = "2026-10-25";

describe("batching", () => {
  it("cooks a keeping recipe once the day before and covers both meals", () => {
    const g = buildPrepGuide([meal("2026-10-26", "dal"), meal("2026-10-28", "dal")], index([recipe("dal")]), { earliest: SUN });
    expect(g.events).toHaveLength(1);
    const e = g.events[0]!;
    expect(e.fresh).toBe(false);
    expect(e.cookDate).toBe(SUN);
    expect(e.servings).toBe(4);
    expect(e.scale).toBe(2);
    expect(e.covers).toHaveLength(2);
    expect(g.sessions).toHaveLength(1);
  });

  it("cooks food that keeps one day or less fresh each time", () => {
    const g = buildPrepGuide([meal("2026-10-26", "chilla"), meal("2026-10-28", "chilla")], index([recipe("chilla", { fridge_days: 1 })]), { earliest: SUN });
    expect(g.events).toHaveLength(2);
    expect(g.events.every((e) => e.fresh)).toBe(true);
    expect(g.sessions).toHaveLength(0);
  });

  it("cooks a recipe that is eaten once on the day, not ahead", () => {
    const g = buildPrepGuide([meal("2026-10-27", "dal")], index([recipe("dal")]), { earliest: SUN });
    expect(g.events[0]!.fresh).toBe(true);
    expect(g.events[0]!.cookDate).toBe("2026-10-27");
  });

  it("never serves a meal after the use-by day and adds a top-up session", () => {
    const meals = [meal("2026-10-26", "stew"), meal("2026-10-27", "stew"), meal("2026-10-31", "stew"), meal("2026-11-01", "stew")];
    const g = buildPrepGuide(meals, index([recipe("stew", { fridge_days: 3 })]), { earliest: SUN });
    expect(g.sessions.map((s) => s.date)).toEqual([SUN, "2026-10-30"]);
    for (const e of g.events) for (const c of e.covers) {
      expect(c.date >= e.cookDate).toBe(true);
      expect(c.date <= e.useBy).toBe(true);
    }
  });

  it("does not schedule cooking before the earliest allowed day", () => {
    const g = buildPrepGuide([meal("2026-10-26", "dal"), meal("2026-10-27", "dal")], index([recipe("dal")]), { earliest: "2026-10-26" });
    expect(g.events[0]!.cookDate).toBe("2026-10-26");
  });

  it("reuses an existing prep day for a second recipe when it still keeps", () => {
    const rs = index([recipe("dal"), recipe("curry")]);
    const g = buildPrepGuide([meal("2026-10-26", "dal"), meal("2026-10-27", "dal"), meal("2026-10-28", "curry"), meal("2026-10-29", "curry")], rs, { earliest: SUN });
    expect(g.sessions).toHaveLength(1);
    expect(g.sessions[0]!.events).toHaveLength(2);
  });

  it("orders long unattended jobs first", () => {
    const rs = index([recipe("quick", { active_min: 15, total_min: 20 }), recipe("slow", { active_min: 15, total_min: 90 })]);
    const g = buildPrepGuide([meal("2026-10-26", "quick"), meal("2026-10-27", "quick"), meal("2026-10-26", "slow"), meal("2026-10-27", "slow")], rs, { earliest: SUN });
    expect(g.sessions[0]!.events.map((e) => e.slug)).toEqual(["slow", "quick"]);
  });
});

describe("night before", () => {
  it("is due the evening before cooking and scales with the batch", () => {
    const r = recipe("rajma", { advance_prep: [{ kind: "soak", ingredient: "x", grams: 200, lead_hours: 10, instruction: "Soak rajma" }] });
    const g = buildPrepGuide([meal("2026-10-26", "rajma"), meal("2026-10-27", "rajma")], index([r]), { earliest: SUN });
    expect(g.nightBefore[0]).toMatchObject({ dueDate: "2026-10-24", text: "Soak rajma (400 g)" });
  });
  it("starts earlier for a lead time over a day", () => {
    const r = recipe("sprouts", { advance_prep: [{ kind: "sprout", lead_hours: 40, instruction: "Start sprouting" }] });
    const g = buildPrepGuide([meal("2026-10-26", "sprouts"), meal("2026-10-27", "sprouts")], index([r]), { earliest: SUN });
    expect(g.nightBefore[0]!.dueDate).toBe("2026-10-23");
  });
});

describe("components", () => {
  const dressing = recipe("dressing", { kind: "component", servings: 1, fridge_days: 7, items: [{ ingredient: "x", grams: 100 }] });
  const salad = (s: string) => recipe(s, { fridge_days: 1, items: [{ ingredient: "x", grams: 100 }, { component: "dressing", grams: 40 }] });
  it("makes a shared dressing once and rounds the batches up", () => {
    const g = buildPrepGuide([meal("2026-10-26", "s1", 2), meal("2026-10-27", "s2", 2)], index([dressing, salad("s1"), salad("s2")]), { earliest: SUN });
    const c = g.events.find((e) => e.kind === "component")!;
    expect(c.fresh).toBe(false);
    expect(c.neededG).toBeCloseTo(80, 5);
    expect(c.scale).toBe(1);
    expect(c.covers).toHaveLength(2);
  });
});

describe("real plan", () => {
  const data = loadData(path.resolve(__dirname, ".."));
  const candidates = buildCandidates(data);
  const dates = datesBetween("2026-11-02", "2026-11-15");
  const plan = generatePlan(
    { dates, mealTypes: ["breakfast", "lunch", "dinner", "snack"], people: [{ id: "a", name: "A", proteinTargetG: 120, kcalTarget: null, liked: new Set(), avoided: new Set() }], cuisineBalance: 0.6, maxActiveMin: null, pinnedRecipes: [], locked: [], seed: 5 },
    candidates,
  );
  const meals: MealRef[] = plan.slots.map((s) => ({ date: s.date, slot: s.slot, recipeSlug: s.recipeSlug, servings: Object.values(s.servings).reduce((a, b) => a + b, 0) }));
  const guide = buildPrepGuide(meals, data.recipes, { earliest: "2026-11-01" });

  it("covers every meal exactly once", () => {
    expect(guide.eat).toHaveLength(meals.length);
  });
  it("keeps every batch inside its use-by day", () => {
    for (const e of guide.events) for (const c of e.covers) {
      expect(c.date >= e.cookDate, `${e.slug} cooked after ${c.date}`).toBe(true);
      expect(c.date <= e.useBy, `${e.slug} used after ${e.useBy}`).toBe(true);
    }
  });
  it("cooks fresh food on the day it is eaten", () => {
    for (const l of guide.eat.filter((x) => x.mode === "fresh")) expect(l.cookDate).toBe(l.date);
  });
  it("never schedules cooking before the earliest day", () => {
    for (const e of guide.events) expect(e.cookDate >= "2026-11-01").toBe(true);
  });
  it("batches something over a two week plan", () => {
    expect(guide.sessions.length).toBeGreaterThanOrEqual(2);
  });
});
