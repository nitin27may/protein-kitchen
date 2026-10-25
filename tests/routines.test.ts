import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { ROUTINE_CAPPED_AISLES, routineHabitTextProblems, routineLinkProblems, routineRecipeProblems } from "../lib/data/rules";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { buildGroceryList } from "../lib/grocery/aggregate";
import { exportHumanData, importHumanData, personKey } from "../lib/human";
import { buildNight, nightTasks } from "../lib/prep/night";
import { catalogByHabit, getRoutineCatalog } from "../lib/routines/catalog";
import { isoWeekday, routineDayTotals, routineInputs, routineMealRefs, scheduledDates } from "../lib/routines/schedule";
import type { PlanRoutineView } from "../lib/routines/types";
import type { Habit, Recipe } from "../lib/schemas";
import { planRoutineRowsFor, readPersonRoutines, readPlanRoutines, savePersonRoutine } from "../lib/server/routine-state";
import { resetCounts, resetData } from "../lib/server/reset";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
const catalog = getRoutineCatalog(data);
const byHabit = catalogByHabit(catalog);
let h: DbHandle;

// A Monday to Sunday week.
const WEEK = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];

const person = async (name = "Test", birthDate = "1985-01-01") => {
  const [p] = await h.db.insert(s.people).values({ name, sex: "male", birthDate, heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id });
  return p!.id;
};
const plan = async (personIds: number[], start = "2026-11-02", end = "2026-11-08") => {
  const [setup] = await h.db.insert(s.planSetups).values({ personIds, startDate: start, endDate: end, mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
  const [p] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
  return p!.id;
};
const habitId = async (slug: string) => (await h.db.select({ id: s.habits.id }).from(s.habits).where(eq(s.habits.slug, slug)))[0]!.id;
const choice = (over: Partial<PlanRoutineView> = {}): PlanRoutineView => ({ planId: 1, personId: 1, habitSlug: "soaked-methi-seeds", days: [1, 2, 3, 4, 5, 6, 7], timeOfDay: "waking", servings: 1, ...over });
const gramsOf = (list: ReturnType<typeof buildGroceryList>) => new Map(list.lines.map((l) => [l.ingredient, l.grams]));

beforeEach(async () => {
  h = await openDb();
  await seedDatabase(h.db, data);
});

describe("routine data", () => {
  it("loads clean and passes every routine rule", () => {
    expect(data.issues).toEqual([]);
    expect(routineLinkProblems(data.habits, data.recipes)).toEqual([]);
    for (const hb of data.habits) expect(routineHabitTextProblems(hb)).toEqual([]);
    const routines = [...data.recipes.values()].filter((r) => r.kind === "routine");
    expect(routines.map((r) => r.slug).sort()).toEqual(["ajwain-water", "chia-water", "jeera-methi-water", "jeera-water", "methi-water", "saunf-water", "soaked-almonds"]);
    for (const r of routines) expect(routineRecipeProblems(r, data.ingredients, data.overrides.routine_item_max_g)).toEqual([]);
  });

  it("builds the catalog from habits and routine recipes", () => {
    expect(catalog.map((o) => o.habitSlug).sort()).toEqual(["ajwain-water", "chia-in-liquid", "jeera-ajwain-water", "jeera-methi-water", "saunf-water", "soaked-almonds", "soaked-methi-seeds"]);
    const methi = byHabit.get("soaked-methi-seeds")!;
    expect(methi).toMatchObject({ recipeSlug: "methi-water", timeOfDay: "waking", defaultDays: [1, 2, 3, 4, 5, 6, 7], grade: "moderate", soakHours: 8 });
    expect(methi.sourceUrl).toMatch(/^https:\/\//);
    expect(methi.caution).toMatch(/pregnancy/i);
    expect(methi.items).toEqual([{ slug: "fenugreek-seed", name: "Fenugreek seed", grams: 3 }]);
    expect(byHabit.get("soaked-almonds")).toMatchObject({ timeOfDay: "morning", defaultDays: [1, 2, 3, 4, 5], soakHours: 8 });
    expect(byHabit.get("chia-in-liquid")).toMatchObject({ timeOfDay: "breakfast", soakHours: 0.25, grade: "practical" });
    // Water is not shopped for, so it is not listed as an item.
    for (const o of catalog) expect(o.items.some((i) => i.slug === "water-tap")).toBe(false);
  });

  it("grades honestly: nothing is above weak without a source, and the combined drink carries the fenugreek caution", () => {
    for (const o of catalog) {
      if (o.grade === "strong" || o.grade === "moderate") expect(o.sourceUrl).toMatch(/^https:\/\//);
    }
    for (const slug of ["ajwain-water", "jeera-methi-water", "saunf-water", "jeera-ajwain-water"]) expect(byHabit.get(slug)!.grade).toBe("weak");
    expect(byHabit.get("jeera-methi-water")!.caution).toMatch(/pregnancy/i);
    expect(byHabit.get("jeera-methi-water")!.caution).toMatch(/diabetes medicine/i);
  });
});

describe("routine validator rules", () => {
  const base = (over: Partial<Recipe> = {}): Recipe => ({
    slug: "test-water", name: "Test water", kind: "routine", family: "routines", meal_slots: [], cuisine: "indian", is_indian: true, servings: 1,
    prep_min: 2, active_min: 2, total_min: 2, equipment: ["glass"], tags: [], fridge_days: 0, status: "draft",
    items: [{ ingredient: "fenugreek-seed", grams: 3 }, { ingredient: "water-tap", grams: 250 }],
    advance_prep: [], steps: [{ text: "Drink the water.", cue: "The glass is empty." }], ...over,
  });
  const habit = (over: Partial<Habit> = {}): Habit => ({ slug: "test-water", title: "Test water", category: "routine_drink", evidence_grade: "weak", evidence_note: "A traditional drink.", source_url: null, caution: null, default_on: false, routine: { recipe: "test-water", time_of_day: "waking", default_days: [1, 2, 3] }, ...over });
  const caps = data.overrides.routine_item_max_g;
  const recipes = (...rs: Recipe[]) => new Map(rs.map((r) => [r.slug, r]));

  it("a routine with no habit is an error", () => {
    expect(routineLinkProblems([], recipes(base()))).toEqual(['routine "test-water" is not linked from any habit']);
  });
  it("a routine linked from two habits is an error", () => {
    const probs = routineLinkProblems([habit(), habit({ slug: "other" })], recipes(base()));
    expect(probs).toHaveLength(1);
    expect(probs[0]).toMatch(/linked from 2 habits/);
  });
  it("a habit pointing at a missing routine or at a meal is an error", () => {
    expect(routineLinkProblems([habit()], recipes())[0]).toMatch(/unknown routine/);
    expect(routineLinkProblems([habit()], recipes(base({ kind: "recipe", meal_slots: ["lunch"] })))[0]).toMatch(/not a routine/);
  });
  it("an amount or household measure in a routine habit's text is an error; plain text and non-routine habits are fine", () => {
    for (const text of ["Use 5 mg daily", "Use a teaspoon of seeds", "Take 2 tbsp", "Drink 250 ml", "About 3 g of seeds"]) {
      expect(routineHabitTextProblems(habit({ evidence_note: text })), text).toHaveLength(1);
    }
    expect(routineHabitTextProblems(habit({ caution: "Ask a doctor first." }))).toEqual([]);
    expect(routineHabitTextProblems(habit({ evidence_note: "Use 5 mg daily", routine: undefined }))).toEqual([]);
  });
  it("a seed over the per-serving cap is an error, and a raised per-ingredient cap is honoured", () => {
    const over = base({ items: [{ ingredient: "fenugreek-seed", grams: 7 }, { ingredient: "water-tap", grams: 250 }] });
    expect(routineRecipeProblems(over, data.ingredients, caps)[0]).toMatch(/above the routine cap of 6 g/);
    const almonds = base({ items: [{ ingredient: "almonds", grams: 15 }] });
    expect(routineRecipeProblems(almonds, data.ingredients, caps)).toEqual([]);
    expect(routineRecipeProblems(base({ items: [{ ingredient: "almonds", grams: 16 }] }), data.ingredients, caps)).toHaveLength(1);
    expect(ROUTINE_CAPPED_AISLES.has("spices") && ROUTINE_CAPPED_AISLES.has("nuts-seeds")).toBe(true);
  });
  it("a volume unit in a step, a missing cue, a missing soak entry and meal slots are each an error", () => {
    expect(routineRecipeProblems(base({ steps: [{ text: "Add 250 ml of water.", cue: "Done now." }] }), data.ingredients, caps)[0]).toMatch(/volume unit/);
    expect(routineRecipeProblems(base({ steps: [{ text: "Add a cup of water.", cue: "Done now." }] }), data.ingredients, caps)[0]).toMatch(/volume unit/);
    expect(routineRecipeProblems(base({ steps: [{ text: "Drink it." }] }), data.ingredients, caps)[0]).toMatch(/cue/);
    expect(routineRecipeProblems(base({ steps: [{ text: "Soak the seeds overnight.", cue: "They are plump." }] }), data.ingredients, caps)[0]).toMatch(/soak entry/);
    expect(routineRecipeProblems(base({ meal_slots: ["lunch"] }), data.ingredients, caps).some((p) => /not a meal/.test(p))).toBe(true);
  });
  it("the loader rejects a recipe in data/routines and a routine in data/recipes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routines-"));
    try {
      fs.mkdirSync(path.join(tmp, "data", "routines"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "data", "recipes", "bowls"), { recursive: true });
      const wrongKind = { ...base({ slug: "meal-in-routines", kind: "recipe", meal_slots: ["lunch"] }) };
      fs.writeFileSync(path.join(tmp, "data", "routines", "meal-in-routines.json"), JSON.stringify(wrongKind));
      const wrongPlace = { ...base({ slug: "routine-in-recipes", family: "bowls" }) };
      fs.writeFileSync(path.join(tmp, "data", "recipes", "bowls", "routine-in-recipes.json"), JSON.stringify(wrongPlace));
      const messages = loadData(tmp).issues.map((i) => i.message);
      expect(messages.some((m) => /must not live in data\/routines/.test(m))).toBe(true);
      expect(messages.some((m) => /must live in data\/routines/.test(m))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("saving a person's routine", () => {
  it("applies the catalog defaults, then the person's own earlier choice", async () => {
    const pid = await person();
    expect(await savePersonRoutine(h.db, byHabit, pid, "soaked-almonds", { active: true })).toEqual({ ok: true });
    expect(await readPersonRoutines(h.db, pid)).toEqual([{ habitSlug: "soaked-almonds", active: true, days: [1, 2, 3, 4, 5], timeOfDay: "morning", servings: 1 }]);
    await savePersonRoutine(h.db, byHabit, pid, "soaked-almonds", { active: true, days: [6, 7], servings: 2 });
    expect((await readPersonRoutines(h.db, pid))[0]).toMatchObject({ days: [6, 7], servings: 2, timeOfDay: "morning" });
    await savePersonRoutine(h.db, byHabit, pid, "soaked-almonds", { active: false });
    expect((await readPersonRoutines(h.db, pid))[0]).toMatchObject({ active: false, days: [6, 7], servings: 2 });
  });
  it("keeps the uid and creation time when a choice is changed, and marks the export", async () => {
    const pid = await person();
    await savePersonRoutine(h.db, byHabit, pid, "soaked-methi-seeds", { active: true });
    const [first] = await h.db.select().from(s.personRoutines);
    await savePersonRoutine(h.db, byHabit, pid, "soaked-methi-seeds", { active: true, servings: 2 });
    const [second] = await h.db.select().from(s.personRoutines);
    expect(second!.uid).toBe(first!.uid);
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(first!.uid).toMatch(/^[0-9a-f-]{36}$/);
    const [sync] = await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, "person-routines"));
    expect(sync).toBeDefined();
  });
  it("rejects an unknown person, a habit with no routine, bad days, a bad time and bad servings", async () => {
    const pid = await person();
    const bad = async (slug: string, patch: Parameters<typeof savePersonRoutine>[4], who = pid) => {
      const r = await savePersonRoutine(h.db, byHabit, who, slug, patch);
      return r.ok ? "ok" : r.error;
    };
    expect(await bad("soaked-methi-seeds", { active: true }, 999)).toMatch(/no longer exists/);
    expect(await bad("plain-water-on-waking", { active: true })).toMatch(/not a routine/);
    expect(await bad("nope", { active: true })).toMatch(/not a routine/);
    expect(await bad("soaked-methi-seeds", { active: true, days: [] })).toMatch(/at least one day/);
    expect(await bad("soaked-methi-seeds", { active: true, days: [1, 1] })).toMatch(/each once/);
    expect(await bad("soaked-methi-seeds", { active: true, days: [0, 8] as never })).toMatch(/Monday to Sunday/);
    expect(await bad("soaked-methi-seeds", { active: true, timeOfDay: "noon" as never })).toMatch(/time of day/);
    for (const servings of [0, 0.5, 4.5, 1.3, Number.NaN]) expect(await bad("soaked-methi-seeds", { active: true, servings }), String(servings)).toMatch(/Servings/);
    expect(await bad("soaked-methi-seeds", { active: true, servings: 1.5 })).toBe("ok");
    expect(await readPersonRoutines(h.db, pid)).toHaveLength(1);
  });
});

describe("routines in a plan", () => {
  it("snapshots active choices of the plan's people, only those with a day inside the plan's dates", async () => {
    const a = await person("A");
    const b = await person("B", "1990-02-02");
    const c = await person("C", "1995-03-03");
    await savePersonRoutine(h.db, byHabit, a, "soaked-methi-seeds", { active: true });
    await savePersonRoutine(h.db, byHabit, a, "soaked-almonds", { active: false });
    await savePersonRoutine(h.db, byHabit, b, "soaked-almonds", { active: true, days: [6, 7] });
    await savePersonRoutine(h.db, byHabit, c, "soaked-methi-seeds", { active: true });
    const midweek = await planRoutineRowsFor(h.db, [a, b], "2026-11-02", "2026-11-04", 5);
    expect(midweek.map((r) => `${r.personId}:${r.habitId === 0 ? "?" : "ok"}:${r.days.join("")}`)).toEqual([`${a}:ok:1234567`]);
    const full = await planRoutineRowsFor(h.db, [a, b], "2026-11-02", "2026-11-08", 5);
    expect(full).toHaveLength(2);
    expect(full.every((r) => r.planId === 5)).toBe(true);
    expect(full.some((r) => r.personId === c)).toBe(false);
  });
  it("stores and reads the snapshot with habit slugs", async () => {
    const a = await person();
    await savePersonRoutine(h.db, byHabit, a, "soaked-almonds", { active: true });
    const planId = await plan([a]);
    for (const row of await planRoutineRowsFor(h.db, [a], "2026-11-02", "2026-11-08", planId)) await h.db.insert(s.planRoutines).values(row);
    expect(await readPlanRoutines(h.db, planId)).toEqual([{ planId, personId: a, habitSlug: "soaked-almonds", days: [1, 2, 3, 4, 5], timeOfDay: "morning", servings: 1 }]);
    // Changing the choice later does not touch the plan.
    await savePersonRoutine(h.db, byHabit, a, "soaked-almonds", { active: true, days: [6] });
    expect((await readPlanRoutines(h.db, planId))[0]!.days).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("scheduling", () => {
  it("knows ISO weekdays and finds scheduled dates", () => {
    expect(isoWeekday("2026-11-02")).toBe(1);
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(scheduledDates(WEEK, [1, 5])).toEqual(["2026-11-02", "2026-11-06"]);
  });
});

describe("routine groceries", () => {
  it("leaves the default list untouched when there are no routines", () => {
    const meals = [{ recipeSlug: "falafel-bowl", servings: 2 }];
    const a = buildGroceryList(meals, data.recipes, data.ingredients);
    expect(buildGroceryList(meals, data.recipes, data.ingredients, undefined, [])).toEqual(a);
    expect(buildGroceryList(meals, data.recipes, data.ingredients, undefined, undefined)).toEqual(a);
  });
  it("scales routine items by scheduled days and people", () => {
    // Two people, methi every day and almonds Mon to Fri (the second person two servings), over one week.
    const choices = [
      choice({ personId: 1, habitSlug: "soaked-methi-seeds" }),
      choice({ personId: 2, habitSlug: "soaked-methi-seeds" }),
      choice({ personId: 1, habitSlug: "soaked-almonds", days: [1, 2, 3, 4, 5] }),
      choice({ personId: 2, habitSlug: "soaked-almonds", days: [1, 2, 3, 4, 5], servings: 2 }),
    ];
    const refs = routineMealRefs(choices, WEEK, byHabit);
    expect(refs).toEqual([{ recipeSlug: "methi-water", servings: 14 }, { recipeSlug: "soaked-almonds", servings: 15 }]);
    const g = gramsOf(buildGroceryList([], data.recipes, data.ingredients, undefined, refs));
    expect(g.get("fenugreek-seed")).toBeCloseTo(3 * 14, 6);
    expect(g.get("almonds")).toBeCloseTo(10 * 15, 6);
    expect(g.has("water-tap")).toBe(false);
  });
  it("shows pantry spices with their amount and the routine name, so they are not silently hidden", () => {
    const refs = routineMealRefs([choice({ habitSlug: "jeera-ajwain-water" })], WEEK, byHabit);
    const list = buildGroceryList([], data.recipes, data.ingredients, undefined, refs);
    const cumin = list.lines.find((l) => l.ingredient === "cumin-seed")!;
    expect(cumin.isPantryStaple).toBe(true);
    expect(cumin.grams).toBeCloseTo(14, 6);
    expect(cumin.buyGrams).toBeGreaterThanOrEqual(14);
    expect(cumin.recipes).toEqual(["jeera-water"]);
    expect(data.recipes.get(cumin.recipes[0]!)!.name).toBe("Jeera water");
  });
  it("adds to a plan's meals rather than replacing them", () => {
    const meals = [{ recipeSlug: "falafel-bowl", servings: 2 }];
    const withRoutine = buildGroceryList(meals, data.recipes, data.ingredients, undefined, routineMealRefs([choice({ habitSlug: "jeera-ajwain-water" })], WEEK, byHabit));
    const without = buildGroceryList(meals, data.recipes, data.ingredients);
    expect(withRoutine.lines.length).toBeGreaterThanOrEqual(without.lines.length);
    expect(gramsOf(withRoutine).get("cumin-seed")!).toBeGreaterThan(gramsOf(without).get("cumin-seed") ?? 0);
  });
});

describe("routine night-before tasks", () => {
  const night = (choices: PlanRoutineView[], dates = WEEK, earliest = "2026-10-30") =>
    nightTasks({ planId: 9, meals: [], recipes: data.recipes, earliest, routines: routineInputs(choices, dates, byHabit) });

  it("is due the evening before the first scheduled morning", () => {
    const tasks = night([choice({ habitSlug: "soaked-almonds", days: [3, 5] })]);
    expect(tasks.map((t) => t.dueDate)).toEqual(["2026-11-03", "2026-11-05"]);
    expect(tasks[0]).toMatchObject({ source: "routine", slug: "soaked-almonds", index: 0, cookDate: "2026-11-04", forName: "Soaked almonds", text: "Soak the almonds in water overnight." });
  });
  it("combines two people on the same evening into one task", () => {
    const tasks = night([choice({ personId: 1, habitSlug: "soaked-methi-seeds" }), choice({ personId: 2, habitSlug: "soaked-methi-seeds" })], ["2026-11-03"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe("Soak the fenugreek seeds in a glass of water overnight. (2 servings)");
    const sum = night([choice({ personId: 1, habitSlug: "soaked-methi-seeds", servings: 1.5 }), choice({ personId: 2, habitSlug: "soaked-methi-seeds", servings: 1 })], ["2026-11-03"]);
    expect(sum[0]!.text).toMatch(/\(2\.5 servings\)$/);
  });
  it("has stable keys that do not contain the instruction text", () => {
    const tasks = night([choice({ habitSlug: "soaked-methi-seeds" })], ["2026-11-03"]);
    expect(tasks[0]!.key).toBe("night:9:2026-11-02:routine:soaked-methi-seeds:0");
    expect(night([choice({ habitSlug: "soaked-methi-seeds" })], ["2026-11-03"])[0]!.key).toBe(tasks[0]!.key);
    const edited = new Map(data.recipes);
    const r = edited.get("methi-water")!;
    edited.set("methi-water", { ...r, advance_prep: [{ ...r.advance_prep[0]!, instruction: "Put the seeds in a glass of water the night before." }] });
    const changed = nightTasks({ planId: 9, meals: [], recipes: edited, earliest: "2026-10-30", routines: routineInputs([choice({ habitSlug: "soaked-methi-seeds" })], ["2026-11-03"], byHabit) });
    expect(changed[0]!.key).toBe(tasks[0]!.key);
    expect(changed[0]!.text).not.toBe(tasks[0]!.text);
  });
  it("gives a short soak (chia, 15 minutes) no night-before task", () => {
    expect(night([choice({ habitSlug: "chia-in-liquid" })])).toEqual([]);
  });
  it("skips an evening that has already passed, and keeps one that is today", () => {
    const tasks = night([choice({ habitSlug: "soaked-methi-seeds" })], ["2026-11-02", "2026-11-03"], "2026-11-02");
    expect(tasks.map((t) => t.dueDate)).toEqual(["2026-11-02"]);
  });
  it("sits alongside recipe tasks and the same input without routines is unchanged", () => {
    const meals = [{ date: "2026-11-03", slot: "dinner" as const, recipeSlug: "falafel-bowl", servings: 2 }];
    const base = nightTasks({ planId: 9, meals, recipes: data.recipes, earliest: "2026-10-30" });
    expect(nightTasks({ planId: 9, meals, recipes: data.recipes, earliest: "2026-10-30", routines: [] })).toEqual(base);
    const both = buildNight({ planId: 9, meals, recipes: data.recipes, earliest: "2026-10-30", routines: routineInputs([choice({ habitSlug: "soaked-methi-seeds" })], ["2026-11-03"], byHabit) });
    expect(both.tasks.length).toBe(base.length + 1);
    expect(both.tasks.some((t) => t.source === "routine")).toBe(true);
  });
});

describe("routine day totals", () => {
  it("adds each person's protein, kcal and fibre per scheduled date", () => {
    const totals = routineDayTotals([choice({ personId: 1, habitSlug: "soaked-almonds", days: [1], servings: 2 })], WEEK, byHabit, data.recipes, data.ingredients);
    expect(Object.keys(totals)).toEqual(["2026-11-02"]);
    const almonds = data.ingredients.get("almonds")!.per100g;
    expect(totals["2026-11-02"]![1]!.protein_g).toBeCloseTo((almonds.protein_g * 10 * 2) / 100, 6);
    expect(totals["2026-11-02"]![1]!.kcal).toBeCloseTo((almonds.kcal * 10 * 2) / 100, 6);
    expect(totals["2026-11-02"]![1]!.fibre_g).toBeGreaterThan(0);
  });
});

describe("person routines in the human-data export", () => {
  it("round trips byte for byte, is idempotent, and exposes neither ids nor the birth date", async () => {
    const a = await person("Asha", "1991-07-14");
    await savePersonRoutine(h.db, byHabit, a, "soaked-methi-seeds", { active: true, days: [2, 4, 6], servings: 1.5 });
    await savePersonRoutine(h.db, byHabit, a, "soaked-almonds", { active: false });
    const first = await exportHumanData(h.db);
    const path1 = `routines/${personKey("Asha", "1991-07-14")}.json`;
    expect(Object.keys(first.files).filter((f) => f.startsWith("routines/"))).toEqual([path1]);
    const text = first.files[path1]!;
    expect(text).not.toMatch(/1991|Asha|person_id|habit_id/);
    expect(first.manifest.tables["person-routines"]!.count).toBe(1);

    const other = await openDb();
    await seedDatabase(other.db, data);
    await other.db.insert(s.people).values({ name: "Someone else", sex: "female", birthDate: "1980-01-01", heightCm: 170, weightKg: 60, activityLevel: "light", proteinGPerKg: 1.2, dietFlags: [] });
    await other.db.insert(s.people).values({ name: "Asha", sex: "female", birthDate: "1991-07-14", heightCm: 165, weightKg: 58, activityLevel: "light", proteinGPerKg: 1.2, dietFlags: [] });
    const report = await importHumanData(other.db, first);
    expect(report.imported["person-routines"]).toBe(2);
    const second = await exportHumanData(other.db);
    expect(second.files[path1]).toBe(text);
    expect(second.manifest.tables["person-routines"]).toEqual(first.manifest.tables["person-routines"]);
    await importHumanData(other.db, first);
    expect((await exportHumanData(other.db)).files[path1]).toBe(text);
  });
  it("skips a person it cannot find", async () => {
    const a = await person("Asha", "1991-07-14");
    await savePersonRoutine(h.db, byHabit, a, "soaked-methi-seeds", { active: true });
    const bundle = await exportHumanData(h.db);
    const fresh = await openDb();
    await seedDatabase(fresh.db, data);
    const report = await importHumanData(fresh.db, bundle);
    expect(report.imported["person-routines"]).toBe(0);
    expect(await fresh.db.select().from(s.personRoutines)).toHaveLength(0);
  });
});

describe("resetting routines", () => {
  const setup = async () => {
    const a = await person();
    await savePersonRoutine(h.db, byHabit, a, "soaked-methi-seeds", { active: true });
    const planId = await plan([a]);
    for (const row of await planRoutineRowsFor(h.db, [a], "2026-11-02", "2026-11-08", planId)) await h.db.insert(s.planRoutines).values(row);
    return { a, planId };
  };
  it("counts both tables", async () => {
    await setup();
    expect(await resetCounts(h.db)).toMatchObject({ routineChoices: 1, planRoutines: 1 });
  });
  it("the plans scope clears what plans copied and keeps the person's choice", async () => {
    await setup();
    await resetData(h.db, "plans");
    expect(await h.db.select().from(s.planRoutines)).toHaveLength(0);
    expect(await h.db.select().from(s.personRoutines)).toHaveLength(1);
  });
  it("ratings, groceries and progress resets leave routines alone", async () => {
    await setup();
    for (const scope of ["ratings", "groceries", "progress"] as const) await resetData(h.db, scope);
    expect(await resetCounts(h.db)).toMatchObject({ routineChoices: 1, planRoutines: 1 });
  });
  it("profiles and everything clear the choices with the people and mark the export", async () => {
    for (const scope of ["profiles", "all"] as const) {
      h = await openDb();
      await seedDatabase(h.db, data);
      await setup();
      await resetData(h.db, scope);
      expect(await resetCounts(h.db)).toMatchObject({ routineChoices: 0, planRoutines: 0 });
      expect((await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, "person-routines"))).length).toBe(1);
    }
  });
});
