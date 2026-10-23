import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { buildNight, dueDateOfKey, migrateTickKey, nightKey, nightTasks, tasksDueOn } from "../lib/prep/night";
import type { NightTask } from "../lib/prep/night";
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
const soak = (over: Partial<Recipe["advance_prep"][number]> = {}): Recipe["advance_prep"][number] => ({ kind: "soak", grams: 100, lead_hours: 12, instruction: "Soak the dal", ...over });
const index = (rs: Recipe[]) => new Map(rs.map((r) => [r.slug, r]));
const meal = (date: string, slug: string, servings = 2, over: Partial<MealRef> = {}): MealRef => ({ date, slot: "dinner", recipeSlug: slug, servings, ...over });
const input = (meals: MealRef[], rs: Recipe[], earliest = "2026-10-20") => ({ planId: 7, meals, recipes: index(rs), earliest });

describe("nightTasks", () => {
  it("shows a component's soak the evening before the cook day (real falafel data)", () => {
    const data = loadData(path.resolve(__dirname, ".."));
    const tasks = nightTasks({ planId: 7, meals: [{ date: "2026-11-03", slot: "dinner", recipeSlug: "falafel-bowl", servings: 2 }], recipes: data.recipes, earliest: "2026-10-26" });
    const chickpeas = tasks.find((t) => t.slug === "baked-falafel");
    expect(chickpeas).toBeDefined();
    expect(chickpeas!.source).toBe("component");
    expect(chickpeas!.dueDate).toBe("2026-11-02");
    expect(chickpeas!.text).toMatch(/Soak chickpeas/);
    expect(chickpeas!.key).toBe("night:7:2026-11-02:component:baked-falafel:0");
  });

  it("recurses into a component inside a component", () => {
    const inner = recipe("inner", { kind: "component", advance_prep: [soak({ instruction: "Soak the inner thing" })] });
    const outer = recipe("outer", { kind: "component", items: [{ component: "inner", grams: 100 }] });
    const top = recipe("top", { items: [{ component: "outer", grams: 200 }] });
    const tasks = nightTasks(input([meal("2026-10-28", "top")], [inner, outer, top]));
    expect(tasks.map((t) => t.slug)).toEqual(["inner"]);
    expect(tasks[0]!.dueDate).toBe("2026-10-27");
  });

  it("gives a batch-cooked meal no task on its reheat day", () => {
    const dal = recipe("dal", { advance_prep: [soak()] });
    const tasks = nightTasks(input([meal("2026-10-26", "dal"), meal("2026-10-28", "dal")], [dal], "2026-10-24"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dueDate).toBe("2026-10-24");
    expect(tasksDueOn(tasks, "2026-10-27")).toHaveLength(0);
    expect(tasks[0]!.text).toBe("Soak the dal (200 g)");
  });

  it("cooks on the first meal's day when later meals are leftovers, so no task is due the evening before the reheat", () => {
    const stew = recipe("stew", { advance_prep: [soak()] });
    const tasks = nightTasks(input([meal("2026-10-27", "stew"), meal("2026-10-28", "stew", 2, { slot: "lunch", leftover: true })], [stew]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.cookDate).toBe("2026-10-27");
    expect(tasks[0]!.dueDate).toBe("2026-10-26");
    expect(tasksDueOn(tasks, "2026-10-27")).toHaveLength(0);
  });

  it("starts a 36 hour sprout two evenings before", () => {
    const sprouts = recipe("sprout-salad", { fridge_days: 1, advance_prep: [{ kind: "sprout", grams: 100, lead_hours: 36, instruction: "Sprout the moong" }] });
    const tasks = nightTasks(input([meal("2026-10-28", "sprout-salad")], [sprouts]));
    expect(tasks[0]!.dueDate).toBe("2026-10-26");
  });

  it("keeps the same keys when the instruction text changes", () => {
    const a = nightTasks(input([meal("2026-10-28", "dal")], [recipe("dal", { advance_prep: [soak({ instruction: "Soak the dal overnight" })] })]));
    const b = nightTasks(input([meal("2026-10-28", "dal")], [recipe("dal", { advance_prep: [soak({ instruction: "Rinse and soak the dal" })] })]));
    expect(a[0]!.text).not.toBe(b[0]!.text);
    expect(a.map((t) => t.key)).toEqual(b.map((t) => t.key));
    expect(a[0]!.key).toBe(nightKey(7, "2026-10-27", "recipe", "dal", 0));
  });

  it("adds the weights when two fresh cooks on one day share a soak, with one key", () => {
    const chilla = recipe("chilla", { fridge_days: 1, advance_prep: [soak({ grams: 80 })] });
    const tasks = nightTasks(input([meal("2026-10-28", "chilla", 2, { slot: "lunch" }), meal("2026-10-28", "chilla", 2, { slot: "dinner" })], [chilla]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe("Soak the dal (160 g)");
  });

  it("is the same list whether a screen takes the tasks or the whole guide", () => {
    const dal = recipe("dal", { advance_prep: [soak()] });
    const i = input([meal("2026-10-28", "dal")], [dal]);
    expect(buildNight(i).tasks.map((t) => t.key)).toEqual(nightTasks(i).map((t) => t.key));
    const key = nightTasks(i)[0]!.key;
    // Today and the prep guide both store a tick under the due evening encoded in the key.
    expect(dueDateOfKey(key)).toBe("2026-10-27");
    expect(dueDateOfKey("prep:7:recipe-dal-2026-10-27")).toBeNull();
  });
});

describe("migrateTickKey", () => {
  const dal = recipe("dal", { advance_prep: [soak()] });
  const tasks: NightTask[] = nightTasks(input([meal("2026-10-28", "dal")], [dal]));
  const ctx = { planId: 7, tasks };
  const newKey = tasks[0]!.key;

  it("maps Today's old key (meal date, slug, index) to the new key", () => {
    expect(migrateTickKey("2026-10-28:dal:0", ctx)).toEqual({ action: "rename", key: newKey, date: "2026-10-27" });
  });

  it("maps the prep page's old key (position and text) to the new key", () => {
    expect(migrateTickKey("night:7:2026-10-27:0:Soak the dal (100 g)", ctx)).toEqual({ action: "rename", key: newKey, date: "2026-10-27" });
  });

  it("is idempotent: a current key is kept, and renaming twice never changes the result", () => {
    expect(migrateTickKey(newKey, ctx)).toEqual({ action: "keep" });
    const first = migrateTickKey("2026-10-28:dal:0", ctx);
    if (first.action !== "rename") throw new Error("expected a rename");
    expect(migrateTickKey(first.key, ctx)).toEqual({ action: "keep" });
  });

  it("drops a tick that matches no current task", () => {
    expect(migrateTickKey("2026-10-28:gone:0", ctx)).toEqual({ action: "drop" });
    expect(migrateTickKey("night:7:2026-10-27:0:Soak something that was removed", ctx)).toEqual({ action: "drop" });
  });

  it("leaves other plans' keys and batch-cook ticks alone", () => {
    expect(migrateTickKey("night:8:2026-10-27:0:Soak the dal (100 g)", ctx)).toEqual({ action: "keep" });
    expect(migrateTickKey("prep:7:recipe-dal-2026-10-27", ctx)).toEqual({ action: "keep" });
  });
});
