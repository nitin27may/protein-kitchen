import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { buildGroceryList } from "../lib/grocery/aggregate";
import { dayPart, daysBetween, firstOpenTask, groceryProgressFrom, groupNightTasks, layoutFor, planPhase, shopByDate } from "../lib/plan/phase";
import { localMinutes } from "../lib/server/time";

const plan = { startDate: "2026-11-02", endDate: "2026-11-08" };

describe("planPhase", () => {
  it("has no plan at all", () => {
    expect(planPhase("2026-11-02", undefined)).toEqual({ kind: "no-plan", reason: "none", endedOn: null });
  });

  it("counts down when the plan starts tomorrow", () => {
    const p = planPhase("2026-11-01", plan, { total: 30, left: 12 }, { text: "Soak chickpeas", forName: "Baked falafel", dueDate: "2026-11-01" });
    expect(p).toMatchObject({ kind: "starts-later", daysUntilStart: 1, startDate: "2026-11-02", grocery: { total: 30, left: 12 }, firstTask: { dueDate: "2026-11-01" } });
  });

  it("counts a plan that starts in a week", () => {
    expect(planPhase("2026-10-26", plan)).toMatchObject({ kind: "starts-later", daysUntilStart: 7 });
  });

  it("is mid-plan on day 1 and on day 5 of 7", () => {
    expect(planPhase("2026-11-02", plan)).toMatchObject({ kind: "mid-plan", dayNumber: 1, totalDays: 7, daysLeft: 6 });
    expect(planPhase("2026-11-06", plan)).toMatchObject({ kind: "mid-plan", dayNumber: 5, daysLeft: 2 });
  });

  it("is in the last two days on the second to last day and the last day", () => {
    expect(planPhase("2026-11-07", plan)).toMatchObject({ kind: "last-two-days", dayNumber: 6, daysLeft: 1 });
    expect(planPhase("2026-11-08", plan)).toMatchObject({ kind: "last-two-days", dayNumber: 7, daysLeft: 0 });
  });

  it("is over the day after the plan ends", () => {
    expect(planPhase("2026-11-09", plan)).toEqual({ kind: "no-plan", reason: "ended", endedOn: "2026-11-08" });
  });

  it("treats a one-day plan as its last two days", () => {
    expect(planPhase("2026-11-02", { startDate: "2026-11-02", endDate: "2026-11-02" })).toMatchObject({ kind: "last-two-days", dayNumber: 1, totalDays: 1, daysLeft: 0 });
  });

  it("counts days across a month boundary and a daylight saving change", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("day part", () => {
  it("switches to day at 11:00 and to evening at 17:00", () => {
    expect(dayPart(0)).toBe("morning");
    expect(dayPart(10 * 60 + 59)).toBe("morning");
    expect(dayPart(11 * 60)).toBe("day");
    expect(dayPart(16 * 60 + 59)).toBe("day");
    expect(dayPart(17 * 60)).toBe("evening");
    expect(dayPart(23 * 60 + 59)).toBe("evening");
  });

  it("reads local minutes from an injected clock, in daylight and standard time", () => {
    const tz = "America/Toronto";
    expect(localMinutes(new Date("2026-10-23T14:59:00Z"), tz)).toBe(10 * 60 + 59); // EDT, UTC-4
    expect(localMinutes(new Date("2026-10-23T15:00:00Z"), tz)).toBe(11 * 60);
    expect(localMinutes(new Date("2026-10-23T20:59:00Z"), tz)).toBe(16 * 60 + 59);
    expect(localMinutes(new Date("2026-10-23T21:00:00Z"), tz)).toBe(17 * 60);
    expect(localMinutes(new Date("2026-12-15T15:59:00Z"), tz)).toBe(10 * 60 + 59); // EST, UTC-5
    expect(localMinutes(new Date("2026-10-23T04:00:00Z"), tz)).toBe(0);
  });

  it("orders the morning boundary 10:59 and 11:00 differently end to end", () => {
    const at = (iso: string) => layoutFor("mid-plan", dayPart(localMinutes(new Date(iso), "America/Toronto")));
    expect(at("2026-10-23T14:59:00Z").main).toEqual(["hero", "basics", "meals", "tonight"]);
    expect(at("2026-10-23T15:00:00Z").main).toEqual(["hero", "meals", "tonight"]);
    expect(at("2026-10-23T20:59:00Z").main).toEqual(["hero", "meals", "tonight"]);
    expect(at("2026-10-23T21:00:00Z").main).toEqual(["hero", "tonight", "meals"]);
  });
});

describe("layoutFor", () => {
  it("keeps basics out of the main column after the morning, and puts groceries in the side column mid-plan", () => {
    const day = layoutFor("mid-plan", "day");
    expect(day.main).not.toContain("basics");
    expect(day.side).toEqual(["grocery", "basics", "snack", "links"]);
  });

  it("shows only the plan prompt and the basics when there is no plan", () => {
    expect(layoutFor("no-plan", "day")).toEqual({ main: ["hero"], side: ["basics", "snack"] });
  });

  it("leads with groceries before the plan starts, and never shows meals", () => {
    const l = layoutFor("starts-later", "day");
    expect(l.main).toEqual(["hero", "grocery", "tonight"]);
    expect([...l.main, ...l.side]).not.toContain("meals");
  });

  it("treats the last two days like mid-plan", () => {
    expect(layoutFor("last-two-days", "evening")).toEqual(layoutFor("mid-plan", "evening"));
  });
});

describe("night task grouping", () => {
  const t = (dueDate: string, cookDate: string, done = false) => ({ dueDate, cookDate, done, key: `${dueDate}:${cookDate}:${done}` });
  const today = "2026-11-03";

  it("puts tasks due today in tonight, ticked or not", () => {
    const g = groupNightTasks([t(today, "2026-11-04"), t(today, "2026-11-04", true)], today);
    expect(g.tonight).toHaveLength(2);
    expect(g.overdue).toHaveLength(0);
  });

  it("flags an unticked task due earlier as overdue while the food is still to be cooked", () => {
    const g = groupNightTasks([t("2026-11-02", "2026-11-03"), t("2026-11-01", "2026-11-04")], today);
    expect(g.overdue.map((x) => x.dueDate)).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("drops overdue tasks that are ticked or whose food was cooked already", () => {
    const g = groupNightTasks([t("2026-11-01", "2026-11-04", true), t("2026-11-01", "2026-11-02")], today);
    expect(g.overdue).toHaveLength(0);
  });

  it("lists later tasks as upcoming, soonest first", () => {
    const g = groupNightTasks([t("2026-11-06", "2026-11-07"), t("2026-11-04", "2026-11-05")], today);
    expect(g.upcoming.map((x) => x.dueDate)).toEqual(["2026-11-04", "2026-11-06"]);
  });

  it("finds the earliest task that is not ticked", () => {
    expect(firstOpenTask([t("2026-11-05", "x"), t("2026-11-03", "x", true), t("2026-11-04", "x")])?.dueDate).toBe("2026-11-04");
    expect(firstOpenTask([t("2026-11-03", "x", true)])).toBeUndefined();
  });
});

describe("shopByDate", () => {
  it("is the day before the plan starts", () => {
    expect(shopByDate("2026-10-23", "2026-10-26")).toBe("2026-10-25");
  });
  it("is the day before an earlier night-before task", () => {
    expect(shopByDate("2026-10-23", "2026-10-26", "2026-10-25")).toBe("2026-10-24");
  });
  it("ignores a task due after the start, and never lands before today", () => {
    expect(shopByDate("2026-10-23", "2026-10-26", "2026-10-28")).toBe("2026-10-25");
    expect(shopByDate("2026-10-25", "2026-10-26", "2026-10-25")).toBe("2026-10-25");
  });
});

describe("grocery progress against a real database", () => {
  let data: DataSet;
  let meals: { recipeSlug: string; servings: number }[];
  let planId: number;
  let h: ReturnType<typeof openDb>;

  beforeAll(async () => {
    const root = path.resolve(__dirname, "..");
    data = loadData(root);
    h = openDb(":memory:", path.join(root, "db", "migrations"));
    await seedDatabase(h.db, data);
    const [person] = await h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id });
    const [setup] = await h.db.insert(s.planSetups).values({ personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["lunch", "dinner"], cuisineBalance: 0.5, createdAt: "2026-11-01" }).returning({ id: s.planSetups.id });
    const [plan] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-11-01" }).returning({ id: s.plans.id });
    planId = plan!.id;
    const rows = [
      ["palak-paneer", "2026-11-02", "lunch", 2],
      ["rajma-masala", "2026-11-02", "dinner", 3],
      ["falafel-bowl", "2026-11-03", "lunch", 2],
    ] as const;
    for (const [slug, date, slot, servings] of rows) {
      const rid = h.sqlite.prepare("select id from recipes where slug = ?").get(slug) as { id: number };
      const [sl] = await h.db.insert(s.planSlots).values({ planId, date, slot, recipeId: rid.id }).returning({ id: s.planSlots.id });
      await h.db.insert(s.planSlotPortions).values({ planSlotId: sl!.id, personId: person!.id, servings });
    }
    // The meals as a page would read them from the database.
    meals = h.sqlite
      .prepare("select r.slug as recipeSlug, sum(p.servings) as servings from plan_slots sl join recipes r on r.id = sl.recipe_id join plan_slot_portions p on p.plan_slot_id = sl.id where sl.plan_id = ? group by sl.id")
      .all(planId) as { recipeSlug: string; servings: number }[];
  });

  const ticked = () => new Set((h.sqlite.prepare("select i.slug from grocery_state g join ingredients i on i.id = g.ingredient_id where g.plan_id = ? and g.checked = 1").all(planId) as { slug: string }[]).map((r) => r.slug));

  it("counts the groceries list without its pantry staples", () => {
    const lines = buildGroceryList(meals, data.recipes, data.ingredients).lines;
    const toBuy = lines.filter((l) => !l.isPantryStaple);
    expect(toBuy.length).toBeGreaterThan(0);
    expect(toBuy.length).toBeLessThan(lines.length);
    expect(groceryProgressFrom(meals, data.recipes, data.ingredients, ticked())).toEqual({ total: toBuy.length, left: toBuy.length });
  });

  it("subtracts ticked items, reading the ticks from the database", async () => {
    const toBuy = buildGroceryList(meals, data.recipes, data.ingredients).lines.filter((l) => !l.isPantryStaple);
    for (const l of toBuy.slice(0, 3)) {
      const id = h.sqlite.prepare("select id from ingredients where slug = ?").get(l.ingredient) as { id: number };
      await h.db.insert(s.groceryState).values({ planId, ingredientId: id.id, checked: true });
    }
    expect(ticked().size).toBe(3);
    expect(groceryProgressFrom(meals, data.recipes, data.ingredients, ticked())).toEqual({ total: toBuy.length, left: toBuy.length - 3 });
  });

  it("reaches zero left when everything is ticked, and ignores ticks on pantry items", async () => {
    const lines = buildGroceryList(meals, data.recipes, data.ingredients).lines;
    for (const l of lines) {
      const id = h.sqlite.prepare("select id from ingredients where slug = ?").get(l.ingredient) as { id: number };
      await h.db.insert(s.groceryState).values({ planId, ingredientId: id.id, checked: true }).onConflictDoUpdate({ target: [s.groceryState.planId, s.groceryState.ingredientId], set: { checked: true } });
    }
    expect(groceryProgressFrom(meals, data.recipes, data.ingredients, ticked())).toMatchObject({ left: 0 });
  });
});
