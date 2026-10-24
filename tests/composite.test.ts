import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandRecipe } from "../lib/grocery/aggregate";
import { buildGroceryList } from "../lib/grocery/aggregate";
import { loadData } from "../lib/data/load";
import {
  componentJustified,
  componentStepsWithoutCue,
  effectiveActiveMin,
  makeAheadMin,
  missingSoakDeep,
  stepOverlap,
  stepsRepeatingParts,
} from "../lib/data/rules";
import { perServing } from "../lib/nutrition/macros";
import { RecipeSchema } from "../lib/schemas";
import type { Recipe } from "../lib/schemas";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
const r = (slug: string) => data.recipes.get(slug)!;

/** A minimal recipe for rule tests. */
function recipe(over: Partial<Recipe> & Pick<Recipe, "slug" | "kind">): Recipe {
  return {
    name: over.slug,
    family: "bowls",
    meal_slots: ["lunch"],
    cuisine: "test",
    is_indian: true,
    servings: 1,
    prep_min: 0,
    active_min: 10,
    total_min: 10,
    equipment: [],
    tags: [],
    fridge_days: 3,
    status: "draft",
    items: [{ ingredient: "salt-table", grams: 1 }],
    advance_prep: [],
    steps: [{ text: "Do it." }],
    ...over,
  } as Recipe;
}

describe("parts: data set", () => {
  it("loads cleanly with components in data/components and meals in data/recipes", () => {
    expect(data.issues).toEqual([]);
    expect(data.recipeFiles.get("hummus")).toBe("data/components/sauces/hummus.json");
    expect(data.recipeFiles.get("falafel-bowl")).toBe("data/recipes/bowls/falafel-bowl.json");
    expect(data.recipes.has("baked-falafel")).toBe(true);
    expect(data.recipes.has("baked-falafel-mix")).toBe(false);
  });

  it("gives every component step a cue and lists water in grams, not in a footnote", () => {
    for (const rec of data.recipes.values()) {
      expect(componentStepsWithoutCue(rec), rec.slug).toEqual([]);
      // Uncounted water only matters for a part, whose yield turns totals into per-gram rates.
      if (rec.kind === "component") for (const s of rec.steps) expect(s.text.toLowerCase()).not.toContain("water is not counted");
    }
    expect(r("hummus").items.some((i) => "ingredient" in i && i.ingredient === "water-tap")).toBe(true);
    expect(r("lemon-tahini-dressing").items.some((i) => "ingredient" in i && i.ingredient === "water-tap")).toBe(true);
  });

  it("only points alt_ingredient at ready-state ingredients that exist", () => {
    let seen = 0;
    for (const rec of data.recipes.values()) {
      for (const it of rec.items) {
        if ("component" in it && it.alt_ingredient) {
          seen++;
          expect(data.ingredients.get(it.alt_ingredient)?.state, `${rec.slug} -> ${it.alt_ingredient}`).toBe("ready");
        }
      }
    }
    expect(seen).toBe(4);
  });

  it("accepts the new component item fields and still rejects macros on a recipe", () => {
    const ok = RecipeSchema.safeParse({ ...r("falafel-bowl") });
    expect(ok.success).toBe(true);
    const bad = RecipeSchema.safeParse({ ...r("falafel-bowl"), kcal: 500 });
    expect(bad.success).toBe(false);
  });
});

describe("effective and make-ahead time", () => {
  it("counts only the bowl's own hands-on time on the day, because every part keeps 2 days or more", () => {
    const bowl = r("falafel-bowl");
    expect(bowl.active_min).toBe(10);
    expect(effectiveActiveMin(bowl, data.recipes)).toBe(10);
  });

  it("puts the falafel, hummus and dressing work in make-ahead time", () => {
    const bowl = r("falafel-bowl");
    const ahead = r("baked-falafel").active_min + r("hummus").active_min + r("lemon-tahini-dressing").active_min;
    expect(makeAheadMin(bowl, data.recipes)).toBe(ahead);
    expect(ahead).toBe(35);
  });

  it("counts a part that keeps fewer than 2 days as work on the day, recursively", () => {
    const sauce = recipe({ slug: "fresh-sauce", kind: "component", active_min: 7, fridge_days: 1 });
    const base = recipe({ slug: "base", kind: "component", active_min: 4, fridge_days: 1, items: [{ component: "fresh-sauce", grams: 10 }] });
    const meal = recipe({ slug: "meal", kind: "recipe", active_min: 10, items: [{ component: "base", grams: 50 }] });
    const idx = new Map([sauce, base, meal].map((x) => [x.slug, x]));
    expect(effectiveActiveMin(meal, idx)).toBe(21);
    expect(makeAheadMin(meal, idx)).toBe(0);
  });

  it("leaves a recipe without parts alone", () => {
    const solo = recipe({ slug: "solo", kind: "recipe", active_min: 12 });
    const idx = new Map([[solo.slug, solo]]);
    expect(effectiveActiveMin(solo, idx)).toBe(12);
    expect(makeAheadMin(solo, idx)).toBe(0);
  });
});

describe("expandRecipe resolver", () => {
  it("is unchanged by default: no resolver, an empty resolver and 'make' agree", () => {
    const base = expandRecipe("falafel-bowl", 2, data.recipes);
    expect([...expandRecipe("falafel-bowl", 2, data.recipes, [], undefined)]).toEqual([...base]);
    expect([...expandRecipe("falafel-bowl", 2, data.recipes, [], () => undefined)]).toEqual([...base]);
    expect([...expandRecipe("falafel-bowl", 2, data.recipes, [], () => "make")]).toEqual([...base]);
    expect(base.get("chickpeas-canned")).toBeGreaterThan(0);
    expect(base.get("water-tap")).toBeGreaterThan(0);
  });

  it("skips a part marked 'have', with everything inside it", () => {
    const out = expandRecipe("falafel-bowl", 2, data.recipes, [], (c) => (c === "hummus" ? "have" : undefined));
    expect(out.has("chickpeas-canned")).toBe(false);
    expect(out.has("chickpeas-dry")).toBe(true);
    const full = expandRecipe("falafel-bowl", 2, data.recipes);
    expect(out.get("water-tap")).toBeLessThan(full.get("water-tap")!);
  });

  it("swaps a part marked 'buy' for its alt_ingredient at the same grams", () => {
    const out = expandRecipe("falafel-bowl", 2, data.recipes, [], (c) => (c === "hummus" ? "buy" : undefined));
    expect(out.get("hummus-commercial")).toBeCloseTo(60, 6);
    expect(out.has("chickpeas-canned")).toBe(false);
    const half = expandRecipe("falafel-bowl", 1, data.recipes, [], (c) => (c === "hummus" ? "buy" : undefined));
    expect(half.get("hummus-commercial")).toBeCloseTo(30, 6);
  });

  it("makes a part that cannot be bought, even if asked to buy it", () => {
    const out = expandRecipe("falafel-bowl", 2, data.recipes, [], (c) => (c === "baked-falafel" ? "buy" : undefined));
    expect([...out]).toEqual([...expandRecipe("falafel-bowl", 2, data.recipes)]);
  });

  it("never puts water on the shopping list", () => {
    const list = buildGroceryList([{ recipeSlug: "falafel-bowl", servings: 2 }], data.recipes, data.ingredients);
    expect(list.lines.some((l) => l.ingredient === "water-tap")).toBe(false);
    expect(list.lines.some((l) => l.ingredient === "tahini")).toBe(true);
  });
});

describe("water and yield", () => {
  it("makes a gram of hummus lighter once its water is listed", () => {
    const hummus = r("hummus");
    const without = { ...hummus, items: hummus.items.filter((i) => !("ingredient" in i && i.ingredient === "water-tap")) };
    const idx = new Map(data.recipes);
    idx.set("hummus", without);
    const withKcal = perServing("hummus-veg-cup", data.recipes, data.ingredients).kcal;
    const withoutKcal = perServing("hummus-veg-cup", idx, data.ingredients).kcal;
    expect(withKcal).toBeLessThan(withoutKcal);
  });

  it("gives water no energy or protein", () => {
    const w = data.ingredients.get("water-tap")!;
    expect(w.per100g).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fibre_g: 0 });
    expect(w.is_pantry_staple).toBe(true);
  });
});

describe("soak check follows parts", () => {
  it("is satisfied when a part carries the soak", () => {
    expect(missingSoakDeep(r("falafel-bowl"), data.recipes)).toEqual([]);
  });

  it("flags dry chickpeas inside a part when nothing soaks them", () => {
    const part = recipe({ slug: "chickpea-part", kind: "component", items: [{ ingredient: "chickpeas-dry", grams: 100 }] });
    const meal = recipe({ slug: "meal", kind: "recipe", items: [{ component: "chickpea-part", grams: 100 }] });
    const idx = new Map([part, meal].map((x) => [x.slug, x]));
    expect(missingSoakDeep(meal, idx)).toEqual(["chickpeas-dry"]);
  });

  it("accepts a soak on the meal for a legume inside a part, and goes two levels deep", () => {
    const inner = recipe({ slug: "inner", kind: "component", items: [{ ingredient: "kidney-beans-dry", grams: 100 }] });
    const outer = recipe({ slug: "outer", kind: "component", items: [{ component: "inner", grams: 100 }] });
    const meal = recipe({ slug: "meal", kind: "recipe", items: [{ component: "outer", grams: 100 }] });
    const idx = new Map([inner, outer, meal].map((x) => [x.slug, x]));
    expect(missingSoakDeep(meal, idx)).toEqual(["kidney-beans-dry"]);
    const soaked = { ...meal, advance_prep: [{ kind: "soak" as const, ingredient: "kidney-beans-dry", lead_hours: 8, instruction: "Soak the beans overnight" }] };
    expect(missingSoakDeep(soaked, idx)).toEqual([]);
  });
});

describe("component rules", () => {
  it("flags component steps that have no cue and ignores recipes", () => {
    const comp = recipe({ slug: "c", kind: "component", steps: [{ text: "Whisk." }, { text: "Rest.", cue: "It is thick and glossy." }] });
    expect(componentStepsWithoutCue(comp)).toEqual([0]);
    expect(componentStepsWithoutCue({ ...comp, kind: "recipe" })).toEqual([]);
  });

  it("justifies a component by reuse, a method that keeps, or a buy alternative", () => {
    const keeps = recipe({ slug: "k", kind: "component", fridge_days: 5, steps: [{ text: "One." }, { text: "Two." }] });
    const oneStep = { ...keeps, steps: [{ text: "One." }] };
    const fresh = { ...keeps, fridge_days: 1 };
    expect(componentJustified(keeps, 1, false)).toBe(true);
    expect(componentJustified(oneStep, 1, false)).toBe(false);
    expect(componentJustified(oneStep, 2, false)).toBe(true);
    expect(componentJustified(oneStep, 1, true)).toBe(true);
    expect(componentJustified(fresh, 1, false)).toBe(false);
  });

  it("warns on every component the data actually keeps for a reason", () => {
    const uses = new Map<string, number>();
    const alt = new Set<string>();
    for (const rec of data.recipes.values()) {
      for (const it of rec.items) {
        if (!("component" in it)) continue;
        if (rec.kind === "recipe") uses.set(it.component, (uses.get(it.component) ?? 0) + 1);
        if (it.alt_ingredient) alt.add(it.component);
      }
    }
    for (const rec of data.recipes.values()) if (rec.kind === "component") expect(componentJustified(rec, uses.get(rec.slug) ?? 0, alt.has(rec.slug)), rec.slug).toBe(true);
  });
});

describe("steps that repeat a part", () => {
  const oldBowlStep =
    "Shape 300 g of raw falafel mixture into 8 patties and bake at 200°C for 25 minutes, turning once.";

  it("measures word overlap between two steps", () => {
    expect(stepOverlap("Bake on an oiled tray at 200°C for 25 minutes, turning once.", oldBowlStep)).toBeGreaterThanOrEqual(0.6);
    expect(stepOverlap("Soak bulgur in boiling water for 15 minutes.", oldBowlStep)).toBeLessThan(0.6);
    expect(stepOverlap("Mix.", "Mix well.")).toBe(0);
  });

  it("would have caught the duplicated falafel step, and finds none in the data now", () => {
    const old = { ...r("falafel-bowl"), steps: [{ text: oldBowlStep }, ...r("falafel-bowl").steps.slice(1)] };
    const hits = stepsRepeatingParts(old, data.recipes);
    expect(hits.some((h) => h.part === "baked-falafel" && h.step === 0)).toBe(true);
    for (const rec of data.recipes.values()) expect(stepsRepeatingParts(rec, data.recipes), rec.slug).toEqual([]);
  });

  it("flags a tip copied word for word from a part's step", () => {
    const bake = data.recipes.get("baked-falafel")!.steps.find((s) => s.tip && s.tip.includes("Space them out"))!;
    const bowl = r("falafel-bowl");
    const copied = { ...bowl, steps: [{ text: "Warm the patties through.", tip: bake.tip }, ...bowl.steps.slice(1)] };
    expect(stepsRepeatingParts(copied, data.recipes).some((h) => h.step === 0 && h.part === "baked-falafel")).toBe(true);
  });
});

describe("data fixes", () => {
  it("counts the water in the four recipes that used to leave it out", () => {
    for (const slug of ["besan-oat-muffins", "spinach-cottage-cheese-bake", "cottage-oat-pancakes", "spiced-protein-chaas"]) {
      expect(r(slug).items.some((i) => "ingredient" in i && i.ingredient === "water-tap"), slug).toBe(true);
      expect(r(slug).steps.some((s) => /not counted/i.test(s.text)), slug).toBe(false);
    }
  });

  it("keeps the kheera-raita calorie override and the falafel rename", () => {
    expect(data.overrides.kcal_per_serving_ok["kheera-raita"]).toBeTruthy();
    expect(data.renames["baked-falafel-mix"]).toBe("baked-falafel");
  });
});

describe("loader folder rules", () => {
  function tmpRoot(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-load-"));
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(body));
    }
    return dir;
  }

  it("rejects a component in data/recipes and a recipe in data/components", () => {
    const comp = recipe({ slug: "oops-part", kind: "component", family: "sauces" });
    const meal = recipe({ slug: "oops-meal", kind: "recipe", family: "bowls" });
    const dir = tmpRoot({ "data/recipes/sauces/oops-part.json": comp, "data/components/bowls/oops-meal.json": meal });
    const messages = loadData(dir).issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("component and must live in data/components/sauces/"))).toBe(true);
    expect(messages.some((m) => m.includes("recipe and must live in data/recipes/bowls/"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts files in the right folders and still checks the family folder", () => {
    const comp = recipe({ slug: "good-part", kind: "component", family: "sauces" });
    const wrongFamily = recipe({ slug: "other-part", kind: "component", family: "dressings" });
    const dir = tmpRoot({ "data/components/sauces/good-part.json": comp, "data/components/sauces/other-part.json": wrongFamily });
    const issues = loadData(dir).issues;
    expect(issues.filter((i) => i.file.includes("good-part"))).toEqual([]);
    expect(issues.some((i) => i.file.includes("other-part") && i.message.includes('folder does not match family "dressings"'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
