import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { ingredientMacros, perServing } from "../lib/nutrition/macros";
import { buildTimeline, effectiveMode, leadLabel, partsOf, partsToMake, usedIn } from "../lib/recipes/parts";
import type { Recipe } from "../lib/schemas";

const root = path.resolve(__dirname, "..");
let data: DataSet;
let bowl: Recipe;

beforeAll(() => {
  data = loadData(root);
  bowl = data.recipes.get("falafel-bowl")!;
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("partsOf", () => {
  it("returns the three parts of the falafel bowl with how long each keeps", () => {
    const parts = partsOf(bowl, data.recipes, data.ingredients, bowl.servings);
    expect(parts.map((p) => p.slug)).toEqual(["baked-falafel", "hummus", "lemon-tahini-dressing"]);
    expect(parts.map((p) => p.fridgeDays)).toEqual([4, 5, 7]);
    expect(parts.every((p) => p.keeps)).toBe(true);
    expect(parts[0]!.displayQty).toBe(8);
    expect(parts[0]!.displayUnit).toBe("patties");
    expect(parts[1]!.hasAlt).toBe(true);
    expect(parts[1]!.altSlug).toBe("hummus-commercial");
    expect(parts[1]!.altName).toBeTruthy();
    expect(parts[0]!.hasAlt).toBe(false);
  });

  it("parts plus the meal's own ingredients add up to the meal's per-serving totals", () => {
    const parts = partsOf(bowl, data.recipes, data.ingredients, bowl.servings);
    const own = bowl.items.flatMap((i) => ("ingredient" in i ? [ingredientMacros(data.ingredients.get(i.ingredient)!, i.grams)] : []));
    const total = perServing("falafel-bowl", data.recipes, data.ingredients);
    expect(sum(parts.map((p) => p.protein)) + sum(own.map((m) => m.protein_g)) / bowl.servings).toBeCloseTo(total.protein_g, 6);
    expect(sum(parts.map((p) => p.kcal)) + sum(own.map((m) => m.kcal)) / bowl.servings).toBeCloseTo(total.kcal, 6);
    expect(sum(parts.map((p) => p.fibre)) + sum(own.map((m) => m.fibre_g)) / bowl.servings).toBeCloseTo(total.fibre_g, 6);
  });

  it("scales weights with the servings viewed but not the per-serving numbers", () => {
    const base = partsOf(bowl, data.recipes, data.ingredients, bowl.servings);
    const double = partsOf(bowl, data.recipes, data.ingredients, bowl.servings * 2);
    expect(double[1]!.grams).toBeCloseTo(base[1]!.grams * 2, 6);
    expect(double[1]!.ingredients[0]!.grams).toBeCloseTo(base[1]!.ingredients[0]!.grams * 2, 6);
    expect(double[1]!.protein).toBeCloseTo(base[1]!.protein, 6);
  });

  it("reports the part's weight as the grams the meal lists", () => {
    const hummus = partsOf(bowl, data.recipes, data.ingredients, bowl.servings)[1]!;
    expect(hummus.grams).toBeCloseTo(60, 6);
    expect(sum(hummus.ingredients.map((i) => i.grams))).toBeCloseTo(60, 6);
  });

  it("carries steps with their cues", () => {
    const hummus = partsOf(bowl, data.recipes, data.ingredients, bowl.servings)[1]!;
    expect(hummus.steps.length).toBeGreaterThan(0);
    expect(hummus.steps.every((s) => !!s.cue)).toBe(true);
  });

  it("returns no parts for a recipe without components", () => {
    const plain = [...data.recipes.values()].find((r) => r.kind === "recipe" && r.items.every((i) => "ingredient" in i))!;
    expect(partsOf(plain, data.recipes, data.ingredients, plain.servings)).toEqual([]);
  });

  it("nests a part inside a part and keeps the parent's numbers inclusive", () => {
    const hummus = data.recipes.get("hummus")!;
    const sauce: Recipe = { ...hummus, slug: "t-sauce", name: "Test sauce", servings: 1, fridge_days: 3, items: [{ ingredient: "tahini", grams: 50 }, { component: "hummus", grams: 60 }] } as Recipe;
    const meal: Recipe = { ...bowl, slug: "t-meal", servings: 1, items: [{ ingredient: "cucumber", grams: 100 }, { component: "t-sauce", grams: 55 }] } as Recipe;
    const recipes = new Map(data.recipes);
    recipes.set(sauce.slug, sauce);
    recipes.set(meal.slug, meal);

    const parts = partsOf(meal, recipes, data.ingredients, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.children.map((c) => c.slug)).toEqual(["hummus"]);
    expect(parts[0]!.children[0]!.protein).toBeLessThan(parts[0]!.protein);

    const total = perServing("t-meal", recipes, data.ingredients);
    const cucumber = ingredientMacros(data.ingredients.get("cucumber")!, 100);
    expect(parts[0]!.protein + cucumber.protein_g).toBeCloseTo(total.protein_g, 6);
    // The meal uses 55 g of a 110 g sauce, so half of it, and half of the 60 g of hummus in the sauce is 30 g.
    expect(parts[0]!.children[0]!.grams).toBeCloseTo(30, 6);
  });
});

describe("buildTimeline", () => {
  const parts = () => partsOf(bowl, data.recipes, data.ingredients, bowl.servings);

  it("makes everything by default: soak the night before, ahead-make the parts, then the day", () => {
    const lines = buildTimeline(parts(), {});
    expect(lines.map((l) => l.text)).toEqual([
      "The night before: soak chickpeas for falafel",
      "Up to 4 days ahead: make baked falafel, hummus and lemon tahini dressing",
      "On the day: put it together",
    ]);
  });

  it("leaves a part out when it is already made", () => {
    const lines = buildTimeline(parts(), { hummus: "have" });
    const ahead = lines.find((l) => l.when.startsWith("Up to"))!;
    expect(ahead.what).toBe("make baked falafel and lemon tahini dressing");
    expect(lines.some((l) => l.text.includes("hummus"))).toBe(false);
  });

  it("adds a shopping line when a part is bought, and does not cook it", () => {
    const lines = buildTimeline(parts(), { hummus: "buy" });
    expect(lines[0]!.when).toBe("When you shop");
    expect(lines[0]!.what).toMatch(/^buy /);
    expect(lines.find((l) => l.when.startsWith("Up to"))!.what).not.toContain("hummus");
  });

  it("treats buy as make when a part has no store-bought alternative", () => {
    const p = parts();
    expect(effectiveMode(p[0]!, { "baked-falafel": "buy" })).toBe("make");
    expect(effectiveMode(p[1]!, { hummus: "buy" })).toBe("buy");
    expect(partsToMake(p, { "baked-falafel": "buy" }).map((x) => x.slug)).toContain("baked-falafel");
    const lines = buildTimeline(p, { "baked-falafel": "buy" });
    expect(lines.some((l) => l.when === "When you shop")).toBe(false);
  });

  it("drops the soak when the falafel is already made", () => {
    const lines = buildTimeline(parts(), { "baked-falafel": "have" });
    expect(lines.some((l) => /soak/i.test(l.text))).toBe(false);
  });

  it("puts fresh parts on the day and uses the meal's own final step and advance prep", () => {
    // No real part is fresh-only yet, so make a salsa that keeps one day.
    const salsa: Recipe = { ...data.recipes.get("salsa-fresca")!, fridge_days: 1 };
    const meal: Recipe = { ...bowl, slug: "t-fresh", items: [{ component: "salsa-fresca", grams: 80 }] } as Recipe;
    const recipes = new Map(data.recipes).set(salsa.slug, salsa).set(meal.slug, meal);
    const lines = buildTimeline(partsOf(meal, recipes, data.ingredients, 2), {}, { finalStep: "assemble", mealAdvancePrep: [{ leadHours: 50, instruction: "Marinate the tofu. Keep it covered" }] });
    expect(lines.map((l) => l.text)).toEqual(["3 days before: marinate the tofu", "On the day: make salsa fresca and assemble"]);
  });

  it("lists only the day when every part is already made", () => {
    const lines = buildTimeline(parts(), { "baked-falafel": "have", hummus: "have", "lemon-tahini-dressing": "have" });
    expect(lines.map((l) => l.text)).toEqual(["On the day: put it together"]);
  });
});

describe("leadLabel", () => {
  it("names the lead time in words", () => {
    expect(leadLabel(12)).toBe("The night before");
    expect(leadLabel(24)).toBe("The night before");
    expect(leadLabel(36)).toBe("2 days before");
    expect(leadLabel(72)).toBe("3 days before");
    expect(leadLabel(2)).toBe("2 hours before");
    expect(leadLabel(1)).toBe("1 hour before");
  });
});

describe("usedIn", () => {
  it("lists the meals that use a part, with the grams per serving", () => {
    const list = usedIn("hummus", data.recipes);
    const bowlRow = list.find((u) => u.slug === "falafel-bowl")!;
    expect(bowlRow.gramsPerServing).toBeCloseTo(30, 6);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((u) => u.slug !== "hummus")).toBe(true);
  });

  it("is empty for something nothing uses", () => {
    expect(usedIn("not-a-part", data.recipes)).toEqual([]);
  });
});
