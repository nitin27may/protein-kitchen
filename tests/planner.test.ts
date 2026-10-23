import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { buildCandidates } from "../lib/planner/candidates";
import { clampServings, generatePlan, isWeeknight, mulberry32, portionsFor, roundToQuarter, suggestSwaps } from "../lib/planner/generate";
import type { Candidate, PersonTarget, PlanInput } from "../lib/planner/types";
import { buildGroceryList, expandRecipe, roundUpPurchase } from "../lib/grocery/aggregate";

let data: DataSet;
let candidates: Candidate[];

const person = (over: Partial<PersonTarget> = {}): PersonTarget => ({
  id: "p1",
  name: "Nitin",
  proteinTargetG: 120,
  kcalTarget: null,
  liked: new Set(),
  avoided: new Set(),
  ...over,
});

const week = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  dates: week,
  mealTypes: ["breakfast", "lunch", "dinner", "snack"],
  people: [person()],
  cuisineBalance: 0.6,
  maxActiveMin: null,
  pinnedRecipes: [],
  locked: [],
  seed: 7,
  ...over,
});

beforeAll(() => {
  data = loadData(path.resolve(__dirname, ".."));
  candidates = buildCandidates(data);
});

describe("helpers", () => {
  it("rounds to quarter servings and clamps", () => {
    expect(roundToQuarter(1.13)).toBe(1.25);
    expect(clampServings(0.1)).toBe(0.5);
    expect(clampServings(5)).toBe(2);
  });
  it("is deterministic for a seed", () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("knows weeknights without time zone drift", () => {
    expect(isWeeknight("2026-11-02")).toBe(true); // Monday
    expect(isWeeknight("2026-11-07")).toBe(false); // Saturday
  });
});

describe("portionsFor", () => {
  const c = { perServing: { kcal: 400, protein_g: 30, carbs_g: 0, fat_g: 0, fibre_g: 0 } } as Candidate;
  it("scales portions to each person's share", () => {
    const out = portionsFor(c, [person({ id: "a", proteinTargetG: 120 }), person({ id: "b", proteinTargetG: 60 })], 0.25);
    expect(out.a).toBe(1);
    expect(out.b).toBe(0.5);
  });
  it("caps by calories when a calorie target is set", () => {
    const out = portionsFor(c, [person({ proteinTargetG: 200, kcalTarget: 1200 })], 0.3);
    expect(out.p1).toBeLessThan(2);
  });
});

describe("generatePlan", () => {
  it("fills every requested slot for every day", () => {
    const plan = generatePlan(input(), candidates);
    expect(plan.slots).toHaveLength(week.length * 4);
  });

  it("is repeatable and the seed changes the result", () => {
    const a = generatePlan(input({ seed: 1 }), candidates).slots.map((s) => s.recipeSlug);
    const b = generatePlan(input({ seed: 1 }), candidates).slots.map((s) => s.recipeSlug);
    const c = generatePlan(input({ seed: 2 }), candidates).slots.map((s) => s.recipeSlug);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });

  it("never repeats a recipe within 3 days and uses a recipe at most twice when options allow", () => {
    const plan = generatePlan(input(), candidates);
    const dayOf = (d: string) => week.indexOf(d);
    for (const slug of new Set(plan.slots.map((s) => s.recipeSlug))) {
      const days = plan.slots.filter((s) => s.recipeSlug === slug).map((s) => dayOf(s.date)).sort((a, b) => a - b);
      expect(days.length).toBeLessThanOrEqual(2);
      for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBeGreaterThan(3);
    }
  });

  it("respects avoided ingredients", () => {
    const plan = generatePlan(input({ people: [person({ avoided: new Set(["paneer"]) })] }), candidates);
    for (const s of plan.slots) expect(candidates.find((c) => c.slug === s.recipeSlug)!.ingredients.has("paneer")).toBe(false);
  });

  it("leans toward liked ingredients", () => {
    const liked = generatePlan(input({ people: [person({ liked: new Set(["tofu-extra-firm"]) })] }), candidates);
    const neutral = generatePlan(input(), candidates);
    const count = (p: typeof liked) => p.slots.filter((s) => candidates.find((c) => c.slug === s.recipeSlug)!.ingredients.has("tofu-extra-firm")).length;
    expect(count(liked)).toBeGreaterThan(count(neutral));
  });

  it("keeps weeknight meals within the active-time limit", () => {
    const plan = generatePlan(input(), candidates);
    for (const s of plan.slots.filter((x) => isWeeknight(x.date))) {
      expect(candidates.find((c) => c.slug === s.recipeSlug)!.activeMin).toBeLessThanOrEqual(20);
    }
  });

  it("keeps locked slots and places pinned recipes", () => {
    const plan = generatePlan(
      input({ locked: [{ date: "2026-11-03", slot: "dinner", recipeSlug: "palak-paneer" }], pinnedRecipes: ["tofu-burrito-bowl"] }),
      candidates,
    );
    const locked = plan.slots.find((s) => s.date === "2026-11-03" && s.slot === "dinner")!;
    expect(locked.recipeSlug).toBe("palak-paneer");
    expect(locked.locked).toBe(true);
    expect(plan.slots.some((s) => s.recipeSlug === "tofu-burrito-bowl")).toBe(true);
  });

  it("adds a shake only when the user selected the shake slot", () => {
    const without = generatePlan(input({ seed: 11 }), candidates);
    expect(without.slots.some((s) => s.slot === "shake")).toBe(false);
    for (const s of without.slots) expect(candidates.find((c) => c.slug === s.recipeSlug)!.family).not.toBe("shakes");
    const withShake = generatePlan(input({ mealTypes: ["breakfast", "lunch", "dinner", "snack", "shake"] }), candidates);
    expect(withShake.slots.filter((s) => s.slot === "shake")).toHaveLength(week.length);
  });

  it("reports a protein gap and suggests a shake when none was chosen", () => {
    const plan = generatePlan(input({ people: [person({ proteinTargetG: 400 })] }), candidates);
    const gap = plan.warnings.find((w) => w.type === "protein_gap");
    expect(gap).toBeDefined();
    if (gap?.type === "protein_gap") expect(gap.suggestion).toBe("add_shake");
  });

  it("gives each person their own portions", () => {
    const plan = generatePlan(input({ people: [person({ id: "a", proteinTargetG: 150 }), person({ id: "b", proteinTargetG: 70 })] }), candidates);
    const s = plan.slots[0]!;
    expect(s.servings.a).toBeGreaterThan(s.servings.b!);
  });

  it("reports a day summary per person", () => {
    const plan = generatePlan(input({ people: [person({ id: "a" }), person({ id: "b" })] }), candidates);
    expect(plan.days).toHaveLength(week.length * 2);
  });
});

describe("suggestSwaps", () => {
  it("returns eligible alternatives for the same slot", () => {
    const inp = input();
    const plan = generatePlan(inp, candidates);
    const swaps = suggestSwaps(plan, { date: "2026-11-04", slot: "dinner" }, inp, candidates);
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.length).toBeLessThanOrEqual(3);
    for (const c of swaps) expect(c.mealSlots).toContain("dinner");
  });
});

describe("grocery", () => {
  it("expands components into ingredient grams", () => {
    const g = expandRecipe("mediterranean-chickpea-salad", 2, data.recipes);
    expect(g.get("chickpeas-canned")).toBeCloseTo(350, 3);
    expect(g.get("tofu-extra-firm")).toBeGreaterThan(0); // from the tofu feta component
  });
  it("scales with servings", () => {
    const one = expandRecipe("palak-paneer", 2, data.recipes).get("paneer")!;
    const two = expandRecipe("palak-paneer", 4, data.recipes).get("paneer")!;
    expect(two).toBeCloseTo(one * 2, 6);
  });
  it("rounds up to packs or to 10 g", () => {
    expect(roundUpPurchase(950, 900)).toEqual({ buyGrams: 1800, packs: 2 });
    expect(roundUpPurchase(251, null)).toEqual({ buyGrams: 260, packs: null });
    expect(roundUpPurchase(250, null).buyGrams).toBe(250);
  });
  it("sums a plan and groups by aisle", () => {
    const list = buildGroceryList(
      [
        { recipeSlug: "palak-paneer", servings: 2 },
        { recipeSlug: "paneer-bhurji", servings: 2 },
      ],
      data.recipes,
      data.ingredients,
    );
    const paneer = list.lines.find((l) => l.ingredient === "paneer")!;
    expect(paneer.grams).toBeCloseTo(500, 3);
    expect(paneer.recipes).toEqual(["palak-paneer", "paneer-bhurji"]);
    expect(Object.keys(list.byAisle)).toContain("dairy");
  });
});

describe("small shortfalls", () => {
  it("does not warn when a day is within 5 g of target", () => {
    const plan = generatePlan(input({ people: [person({ proteinTargetG: 100 })] }), candidates);
    for (const w of plan.warnings) if (w.type === "protein_gap") expect(w.gapG).toBeGreaterThanOrEqual(5);
  });
});

describe("accompaniments", () => {
  it("never plans a side or a bread as a meal", () => {
    const plan = generatePlan(input(), candidates);
    for (const s of plan.slots) {
      const fam = candidates.find((c) => c.slug === s.recipeSlug)!.family;
      expect(["sides", "breads"]).not.toContain(fam);
    }
  });
});

describe("healthy focus", () => {
  const avg = (plan: ReturnType<typeof generatePlan>, pick: (c: Candidate) => number) => {
    const vals = plan.slots.map((s) => pick(candidates.find((c) => c.slug === s.recipeSlug)!));
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const seeds = [1, 2, 3, 4, 5, 6];
  const run = (healthFocus?: PlanInput["healthFocus"]) => seeds.map((seed) => generatePlan(input({ seed, healthFocus }), candidates));

  it("raises the average nutrient score when asked", () => {
    const withFocus = run({ nutrientDense: true, lowSugar: true, light: true });
    const without = run(undefined);
    const mean = (plans: typeof withFocus) => plans.reduce((s, p) => s + avg(p, (c) => c.nutrientScore), 0) / plans.length;
    expect(mean(withFocus)).toBeGreaterThan(mean(without));
  });

  it("lowers average free sugar and calories per slot", () => {
    const withFocus = run({ nutrientDense: true, lowSugar: true, light: true });
    const without = run(undefined);
    const kcal = (plans: typeof withFocus) => plans.reduce((s, p) => s + avg(p, (c) => c.perServing.kcal), 0) / plans.length;
    expect(kcal(withFocus)).toBeLessThan(kcal(without));
    const sugar = (plans: typeof withFocus) => plans.reduce((s, p) => s + avg(p, (c) => c.freeSugarG), 0) / plans.length;
    expect(sugar(withFocus)).toBeLessThanOrEqual(sugar(without));
  });

  it("still meets protein targets with the focus on", () => {
    for (const plan of run({ nutrientDense: true, lowSugar: true, light: true })) {
      const metOrNear = plan.days.filter((d) => d.status !== "short").length / plan.days.length;
      expect(metOrNear).toBeGreaterThanOrEqual(0.7);
    }
  });
});

describe("cooking styles", () => {
  const weekInput = (prepStyle: PlanInput["prepStyle"], seed = 3) => input({ prepStyle, seed, maxActiveMin: 999 });

  it("variety never repeats a dinner as a lunch", () => {
    const plan = generatePlan(weekInput("variety"), candidates);
    expect(plan.slots.some((s) => s.isLeftover)).toBe(false);
  });

  it("leftovers makes next day's lunch the dinner that keeps", () => {
    const plan = generatePlan(weekInput("leftovers"), candidates);
    const leftovers = plan.slots.filter((s) => s.isLeftover);
    expect(leftovers.length).toBeGreaterThanOrEqual(3);
    for (const l of leftovers) {
      expect(l.slot).toBe("lunch");
      const prev = week[week.indexOf(l.date) - 1]!;
      const dinner = plan.slots.find((s) => s.date === prev && s.slot === "dinner")!;
      expect(dinner.recipeSlug).toBe(l.recipeSlug);
      expect(candidates.find((c) => c.slug === l.recipeSlug)!.fridgeDays).toBeGreaterThanOrEqual(2);
    }
  });

  it("batch repeats a lunch for two or three days, never more", () => {
    const plan = generatePlan(weekInput("batch"), candidates);
    const lunches = week.map((d) => plan.slots.find((s) => s.date === d && s.slot === "lunch")!.recipeSlug);
    let run = 1;
    let longest = 1;
    let repeats = 0;
    for (let i = 1; i < lunches.length; i++) {
      if (lunches[i] === lunches[i - 1]) {
        run++;
        repeats++;
      } else run = 1;
      longest = Math.max(longest, run);
    }
    expect(repeats).toBeGreaterThanOrEqual(2);
    expect(longest).toBeLessThanOrEqual(3);
  });

  it("leaves a leftover alone when its recipe is avoided", () => {
    const plan = generatePlan({ ...weekInput("leftovers"), people: [person({ avoided: new Set(["paneer"]) })] }, candidates);
    for (const s of plan.slots) expect(candidates.find((c) => c.slug === s.recipeSlug)!.ingredients.has("paneer")).toBe(false);
  });

  it("gives the prep guide something to batch", async () => {
    const { buildPrepGuide } = await import("../lib/prep/session");
    const toMeals = (p: ReturnType<typeof generatePlan>) => p.slots.map((s) => ({ date: s.date, slot: s.slot, recipeSlug: s.recipeSlug, servings: Object.values(s.servings).reduce((a, b) => a + b, 0) }));
    const batchEvents = (style: PlanInput["prepStyle"]) => buildPrepGuide(toMeals(generatePlan(weekInput(style), candidates)), data.recipes, { earliest: "2026-11-01" }).events.filter((e) => !e.fresh && e.kind === "recipe").length;
    expect(batchEvents("leftovers")).toBeGreaterThan(batchEvents("variety"));
    expect(batchEvents("batch")).toBeGreaterThan(batchEvents("variety"));
  });
});
