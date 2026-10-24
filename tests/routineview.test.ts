import { describe, expect, it } from "vitest";
import type { PersonRoutineView, PlanRoutineView, RoutineOption } from "../lib/routines/types";
import {
  daysPhrase,
  defaultsFor,
  describeDays,
  GROUP_THRESHOLD,
  groupByTime,
  isEveryDay,
  isWeekdays,
  normaliseDays,
  planRoutineRows,
  shouldGroup,
  soakLine,
  sortRoutines,
  stepServings,
  summaryLine,
  toggleDay,
} from "../lib/routines/view";

const option = (over: Partial<RoutineOption> & Pick<RoutineOption, "habitSlug" | "title">): RoutineOption => ({
  recipeSlug: `${over.habitSlug}-recipe`,
  timeOfDay: "waking",
  defaultDays: [1, 2, 3, 4, 5, 6, 7],
  grade: "weak",
  evidenceNote: "A traditional drink.",
  caution: null,
  sourceUrl: null,
  soakHours: null,
  items: [],
  ...over,
});

const chosen = (habitSlug: string, active = true): PersonRoutineView => ({ habitSlug, active, days: [1, 2, 3, 4, 5, 6, 7], timeOfDay: "waking", servings: 1 });

describe("days", () => {
  it("describes the common patterns in words", () => {
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([6, 7])).toBe("Weekends");
    expect(describeDays([5, 1, 3])).toBe("Mon, Wed, Fri");
    expect(describeDays([])).toBe("No days");
  });

  it("ignores order, repeats and values outside Monday to Sunday", () => {
    expect(normaliseDays([7, 1, 1, 9, 0, 3])).toEqual([1, 3, 7]);
    expect(describeDays([5, 4, 3, 2, 1, 1])).toBe("Weekdays");
  });

  it("phrases days for use inside a sentence", () => {
    expect(daysPhrase([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(daysPhrase([1, 2, 3, 4, 5])).toBe("on weekdays");
    expect(daysPhrase([6, 7])).toBe("on weekends");
    expect(daysPhrase([2, 4])).toBe("on Tue, Thu");
  });

  it("toggles a day on and off but never removes the last one", () => {
    expect(toggleDay([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleDay([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggleDay([4], 4)).toEqual([4]);
  });

  it("recognises the quick presets", () => {
    expect(isEveryDay([1, 2, 3, 4, 5, 6, 7])).toBe(true);
    expect(isEveryDay([1, 2, 3, 4, 5])).toBe(false);
    expect(isWeekdays([5, 4, 3, 2, 1])).toBe(true);
    expect(isWeekdays([1, 2, 3, 4, 5, 6])).toBe(false);
  });
});

describe("servings", () => {
  it("moves by a half and stays between 1 and 4", () => {
    expect(stepServings(1, 1)).toBe(1.5);
    expect(stepServings(1.5, -1)).toBe(1);
    expect(stepServings(1, -1)).toBe(1);
    expect(stepServings(4, 1)).toBe(4);
    expect(stepServings(3.5, 1)).toBe(4);
  });
});

describe("sortRoutines", () => {
  const opts = [
    option({ habitSlug: "chia", title: "Chia water", timeOfDay: "morning" }),
    option({ habitSlug: "methi", title: "Methi water", timeOfDay: "waking" }),
    option({ habitSlug: "almonds", title: "Soaked almonds", timeOfDay: "breakfast" }),
    option({ habitSlug: "ajwain", title: "Ajwain water", timeOfDay: "waking" }),
  ];

  it("puts chosen routines first, then orders by time of day and title", () => {
    const sorted = sortRoutines(opts, [chosen("almonds")]).map((o) => o.habitSlug);
    expect(sorted).toEqual(["almonds", "ajwain", "methi", "chia"]);
  });

  it("does not count a routine that is switched off as chosen", () => {
    const sorted = sortRoutines(opts, [chosen("almonds", false)]).map((o) => o.habitSlug);
    expect(sorted).toEqual(["ajwain", "methi", "chia", "almonds"]);
  });

  it("leaves its input untouched", () => {
    const before = opts.map((o) => o.habitSlug);
    sortRoutines(opts, [chosen("chia")]);
    expect(opts.map((o) => o.habitSlug)).toEqual(before);
  });
});

describe("groupByTime", () => {
  it("returns groups in day order and skips empty ones", () => {
    const groups = groupByTime([
      option({ habitSlug: "a", title: "A", timeOfDay: "bedtime" }),
      option({ habitSlug: "b", title: "B", timeOfDay: "waking" }),
      option({ habitSlug: "c", title: "C", timeOfDay: "waking" }),
    ]);
    expect(groups.map((g) => g.time)).toEqual(["waking", "bedtime"]);
    expect(groups[0]!.label).toBe("On waking");
    expect(groups[0]!.options.map((o) => o.habitSlug)).toEqual(["b", "c"]);
  });

  it("only groups once there are more than five routines", () => {
    expect(GROUP_THRESHOLD).toBe(5);
    expect(shouldGroup(5)).toBe(false);
    expect(shouldGroup(6)).toBe(true);
  });
});

describe("summaryLine and soakLine", () => {
  it("describes what a routine is made of using only the catalog names", () => {
    expect(summaryLine({ items: [] })).toBe("");
    expect(summaryLine({ items: [{ slug: "f", name: "Fenugreek seed", grams: 3 }] })).toBe("Made from fenugreek seed.");
    expect(summaryLine({ items: [{ slug: "f", name: "Fenugreek seed", grams: 3 }, { slug: "w", name: "Water", grams: 250 }] })).toBe("Made from fenugreek seed and water.");
    expect(summaryLine({ items: [{ slug: "c", name: "Cumin seed", grams: 2 }, { slug: "f", name: "Fenugreek seed", grams: 2 }, { slug: "w", name: "Water", grams: 250 }] })).toBe("Made from cumin seed, fenugreek seed and water.");
  });

  it("keeps acronyms and drops repeats", () => {
    expect(summaryLine({ items: [{ slug: "a", name: "IFCT seed", grams: 1 }] })).toBe("Made from IFCT seed.");
    expect(summaryLine({ items: [{ slug: "a", name: "Water", grams: 1 }, { slug: "b", name: "water", grams: 1 }] })).toBe("Made from water.");
  });

  it("says to soak the night before only when the routine needs soaking", () => {
    expect(soakLine({ soakHours: 8 })).toBe("Soak the night before");
    expect(soakLine({ soakHours: null })).toBeNull();
  });
});

describe("defaultsFor", () => {
  it("starts from the routine's own day and time, with one serving", () => {
    expect(defaultsFor(option({ habitSlug: "x", title: "X", timeOfDay: "bedtime", defaultDays: [5, 1] }))).toEqual({ days: [1, 5], timeOfDay: "bedtime", servings: 1 });
  });

  it("falls back to every day when the routine names none", () => {
    expect(defaultsFor(option({ habitSlug: "x", title: "X", defaultDays: [] })).days).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("planRoutineRows", () => {
  const catalog = [
    option({ habitSlug: "methi", title: "Methi water", timeOfDay: "waking", soakHours: 8 }),
    option({ habitSlug: "almonds", title: "Soaked almonds", timeOfDay: "breakfast" }),
  ];
  const kept = (personId: number, habitSlug: string, timeOfDay: PlanRoutineView["timeOfDay"], days: number[] = [1, 2, 3, 4, 5, 6, 7]): PlanRoutineView => ({ planId: 1, personId, habitSlug, days: days as PlanRoutineView["days"], timeOfDay, servings: 1 });

  it("joins titles and the soak flag from the catalog and words the days", () => {
    const [row] = planRoutineRows([kept(2, "methi", "waking", [1, 2, 3, 4, 5])], catalog);
    expect(row).toMatchObject({ personId: 2, title: "Methi water", timeLabel: "On waking", daysLabel: "Weekdays", daysPhrase: "on weekdays", soak: true });
  });

  it("orders by person, then time of day, then title", () => {
    const rows = planRoutineRows([kept(2, "almonds", "breakfast"), kept(1, "almonds", "breakfast"), kept(1, "methi", "waking")], catalog);
    expect(rows.map((r) => `${r.personId}:${r.habitSlug}`)).toEqual(["1:methi", "1:almonds", "2:almonds"]);
  });

  it("keeps a routine that has left the catalog, using its slug as the title", () => {
    const [row] = planRoutineRows([kept(1, "retired-routine", "evening")], catalog);
    expect(row).toMatchObject({ title: "retired-routine", soak: false });
  });

  it("returns nothing for a plan with no routines", () => {
    expect(planRoutineRows([], catalog)).toEqual([]);
  });
});
