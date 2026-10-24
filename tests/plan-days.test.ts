import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { shopByDate } from "../lib/plan/phase";
import { buildNight } from "../lib/prep/night";
import { buildPrepGuide, effectivePrepDay } from "../lib/prep/session";
import type { MealRef } from "../lib/prep/session";
import { isIsoWeekday, isoWeekdayOf, lastWeekdayOnOrBefore } from "../lib/planner/weekdays";

const root = path.resolve(__dirname, "..");
const data = loadData(root);

describe("weekday helpers", () => {
  it("numbers days 1 (Monday) to 7 (Sunday)", () => {
    expect(isoWeekdayOf("2026-11-02")).toBe(1);
    expect(isoWeekdayOf("2026-11-08")).toBe(7);
    expect(isoWeekdayOf("2026-11-07")).toBe(6);
  });

  it("finds the last matching weekday on or before a date, never after it", () => {
    expect(lastWeekdayOnOrBefore("2026-11-04", 7)).toBe("2026-11-01"); // Wed back to Sun
    expect(lastWeekdayOnOrBefore("2026-11-04", 3)).toBe("2026-11-04"); // already that day
    expect(lastWeekdayOnOrBefore("2026-11-04", 4)).toBe("2026-10-29"); // Thu is after Wed, so last week
    for (let d = 1; d <= 7; d++) {
      const r = lastWeekdayOnOrBefore("2026-11-04", d as 1);
      expect(r <= "2026-11-04").toBe(true);
      expect(isoWeekdayOf(r)).toBe(d);
    }
  });

  it("validates weekdays", () => {
    expect([0, 1, 7, 8, 2.5, "3", null, undefined].map(isIsoWeekday)).toEqual([false, true, true, false, false, false, false, false]);
  });
});

describe("shop by", () => {
  // Plan starts Monday 2026-11-02, so the day before the first need is Sunday 2026-11-01.
  const start = "2026-11-02";

  it("is the day before the first need when no day is chosen (unchanged)", () => {
    expect(shopByDate("2026-10-23", start)).toBe("2026-11-01");
    expect(shopByDate("2026-10-23", start, null, null)).toBe("2026-11-01");
    expect(shopByDate("2026-10-23", start, "2026-10-30")).toBe("2026-10-29");
  });

  it("is the last chosen weekday on or before that day", () => {
    expect(shopByDate("2026-10-23", start, null, 6)).toBe("2026-10-31"); // Saturday
    expect(shopByDate("2026-10-23", start, null, 7)).toBe("2026-11-01"); // Sunday is the day before the start
    expect(shopByDate("2026-10-23", start, null, 5)).toBe("2026-10-30"); // Friday
    expect(shopByDate("2026-10-23", start, null, 1)).toBe("2026-10-26"); // Monday
  });

  it("follows an earlier first task", () => {
    // First night-before task is Thursday 29th, so shopping is done by Wednesday the 28th at the latest.
    expect(shopByDate("2026-10-23", start, "2026-10-29", 6)).toBe("2026-10-24");
    expect(shopByDate("2026-10-23", start, "2026-10-29", 3)).toBe("2026-10-28");
  });

  it("is today when today is the chosen shopping day", () => {
    expect(shopByDate("2026-10-31", start, null, 6)).toBe("2026-10-31");
  });

  it("is never before today, even when the chosen weekday has passed", () => {
    // Saturday 31st is the last Saturday on or before Sunday 1st, but today is already Sunday.
    expect(shopByDate("2026-11-01", start, null, 6)).toBe("2026-11-01");
    expect(shopByDate("2026-11-01", start, null, null)).toBe("2026-11-01");
  });
});

describe("prep day", () => {
  const rajma = data.recipes.get("rajma-masala")!;
  const meals: MealRef[] = [
    { date: "2026-11-04", slot: "dinner", recipeSlug: "rajma-masala", servings: 2 }, // Wednesday
    { date: "2026-11-05", slot: "dinner", recipeSlug: "rajma-masala", servings: 2 },
  ];
  const sessions = (opts: Parameters<typeof buildPrepGuide>[2]) => buildPrepGuide(meals, data.recipes, opts).sessions.map((x) => x.date);

  it("assumes a recipe that keeps for four days", () => {
    expect(rajma.fridge_days).toBe(4);
  });

  it("cooks the day before the first meal when no prep day is set, as always", () => {
    expect(sessions({ earliest: "2026-10-23" })).toEqual(["2026-11-03"]);
  });

  it("is byte-identical to before when the prep day is unset or null", () => {
    const plain = buildPrepGuide(meals, data.recipes, { earliest: "2026-10-23" });
    expect(buildPrepGuide(meals, data.recipes, { earliest: "2026-10-23", prepDay: null })).toEqual(plain);
    expect(buildPrepGuide(meals, data.recipes, { earliest: "2026-10-23", prepDay: undefined })).toEqual(plain);
  });

  it("batch cooks on the chosen weekday, on or before the day before the first meal", () => {
    // Sunday 1 Nov is three days before the Wednesday meal and the food keeps four days.
    expect(sessions({ earliest: "2026-10-23", prepDay: 7 })).toEqual(["2026-11-01"]);
    // Tuesday is the day before: nothing earlier is needed.
    expect(sessions({ earliest: "2026-10-23", prepDay: 2 })).toEqual(["2026-11-03"]);
    // Monday 2 Nov.
    expect(sessions({ earliest: "2026-10-23", prepDay: 1 })).toEqual(["2026-11-02"]);
  });

  it("never cooks after the first meal that needs the food", () => {
    for (let d = 1; d <= 7; d++) for (const date of sessions({ earliest: "2026-10-23", prepDay: d as 1 })) expect(date < "2026-11-04").toBe(true);
  });

  it("falls back to the day before when the chosen day would be too early for the food to keep", () => {
    // Wednesday itself is not before the meal, so the last Wednesday is a week earlier: 7 days, the food keeps 4.
    expect(sessions({ earliest: "2026-10-23", prepDay: 3 })).toEqual(["2026-11-03"]);
    // Thursday: last Thursday is 29 Oct, six days before, so again the day before.
    expect(sessions({ earliest: "2026-10-23", prepDay: 4 })).toEqual(["2026-11-03"]);
  });

  it("does not cook before it is possible", () => {
    // Today is Monday 2 Nov, so Sunday 1 Nov has passed and cooking falls back to the day before the meal.
    expect(sessions({ earliest: "2026-11-02", prepDay: 7 })).toEqual(["2026-11-03"]);
  });

  it("moves night-before tasks with the cooking day", () => {
    const withDay = buildNight({ planId: 1, meals, recipes: data.recipes, earliest: "2026-10-23", prepDay: 7 });
    const without = buildNight({ planId: 1, meals, recipes: data.recipes, earliest: "2026-10-23" });
    const soak = (n: typeof withDay) => n.tasks.find((t) => /rajma/i.test(t.text))?.dueDate;
    expect(soak(without)).toBe("2026-11-02");
    expect(soak(withDay)).toBe("2026-10-31");
  });

  it("applies only to the cooking styles that cook ahead", () => {
    expect(effectivePrepDay(7, "leftovers")).toBe(7);
    expect(effectivePrepDay(7, "batch")).toBe(7);
    expect(effectivePrepDay(7, "variety")).toBeNull();
    expect(effectivePrepDay(7, null)).toBeNull();
    expect(effectivePrepDay(7, undefined)).toBeNull();
    expect(effectivePrepDay(null, "batch")).toBeNull();
    expect(effectivePrepDay(undefined, "batch")).toBeNull();
  });
});
