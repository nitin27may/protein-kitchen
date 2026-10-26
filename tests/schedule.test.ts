import { describe, expect, it } from "vitest";
import type { MealRow, PlanExport } from "../lib/export/model";
import { buildScheduleModel, shortDate, type SchedulePrepTask } from "../lib/export/schedule-model";
import { FIT_LEVELS, buildSchedulePdf, clip, countPdfPages, estimateHeight, fitPrep, scheduleDefinition } from "../lib/export/schedule-pdf";

const LONG = "Slow roasted spiced cauliflower and chickpea tray bake with whipped feta yogurt dressing and charred flatbread wedges";
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function meal(date: string, slot: string, recipe: string, person: string, portion: string, extra: Partial<MealRow> = {}): MealRow {
  return { week: 1, date, day: date, slot, recipe, person, portion, servings: 1, weightG: 300, leftover: false, partial: false, ...extra } as MealRow;
}

function plan(days: number, opts: { names?: (i: number, slot: string) => string; shake?: boolean; start?: string; people?: string[] } = {}): PlanExport {
  const start = opts.start ?? "2026-11-02";
  const people = opts.people ?? ["Asha", "Ben"];
  const meals: MealRow[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDay(start, i);
    for (const slot of ["Breakfast", "Lunch", "Snack", "Dinner", ...(opts.shake ? ["Shake"] : [])]) {
      people.forEach((p, k) => meals.push(meal(date, slot, opts.names?.(i, slot) ?? `${slot} dish ${i}`, p, k === 0 ? "2 rotis" : "1 roti", { week: Math.floor(i / 7) + 1 })));
    }
  }
  const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, w) => ({ n: w + 1, from: addDay(start, w * 7), to: addDay(start, Math.min(w * 7 + 6, days - 1)), label: `Week ${w + 1}` }));
  return {
    title: "Meal plan", startDate: start, endDate: addDay(start, days - 1), generatedOn: "2026-11-01", weeks,
    people: people.map((name, i) => ({ id: i + 1, name, proteinTargetG: 100, kcalTarget: null })),
    meals, days: [], averages: [], grocery: [], notes: [],
  };
}

const prepFor = (n: number): SchedulePrepTask[] => Array.from({ length: n }, (_, i) => ({ dueDate: addDay("2026-11-02", i % 7), text: `Soak the dried beans for tomorrow number ${i} (200 g)`, forName: `Recipe ${i}` }));

function fontSizes(node: unknown, out: number[] = []): number[] {
  if (Array.isArray(node)) node.forEach((n) => fontSizes(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "fontSize" && typeof v === "number") out.push(v);
      else if (typeof v === "object") fontSizes(v, out);
    }
  }
  return out;
}

describe("buildScheduleModel", () => {
  it("titles the week with weekdays and dates, one row per day, in print order", () => {
    const m = buildScheduleModel(plan(7), [])!;
    expect(m.weeks[0]!.title).toBe("Week of Mon 2 Nov to Sun 8 Nov");
    expect(m.weeks[0]!.days.map((d) => d.weekday)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(m.slots).toEqual(["Breakfast", "Lunch", "Snack", "Dinner"]);
    expect(shortDate("2026-12-09")).toBe("9 Dec");
  });
  it("adds a Shake column only when the plan uses one", () => {
    expect(buildScheduleModel(plan(7), [])!.slots).not.toContain("Shake");
    expect(buildScheduleModel(plan(7, { shake: true }), [])!.slots).toEqual(["Breakfast", "Lunch", "Snack", "Dinner", "Shake"]);
  });
  it("leaves cells empty when nothing is planned", () => {
    const p = plan(7);
    p.meals = p.meals.filter((x) => !(x.date === "2026-11-03" && x.slot === "Snack"));
    const day = buildScheduleModel(p, [])!.weeks[0]!.days[1]!;
    expect(day.cells.Snack).toBeUndefined();
    expect(day.cells.Lunch).toHaveLength(1);
  });
  it("gives one week per 7 days, and a single week on request", () => {
    const p = plan(14);
    expect(buildScheduleModel(p, [])!.weeks.map((w) => w.n)).toEqual([1, 2]);
    expect(buildScheduleModel(p, [], { week: 2 })!.weeks.map((w) => w.title)).toEqual(["Week of Mon 9 Nov to Sun 15 Nov"]);
    expect(buildScheduleModel(p, [], { week: 3 })).toBeUndefined();
  });
  it("changes servings text with the person selected", () => {
    const p = plan(7);
    const all = buildScheduleModel(p, [])!.weeks[0]!.days[0]!.cells.Lunch![0]!;
    expect(all.detail).toBe("Asha: 2 rotis · Ben: 1 roti");
    const asha = buildScheduleModel(p, [], { personId: 1 })!;
    const ben = buildScheduleModel(p, [], { personId: 2 })!;
    expect(asha.weeks[0]!.days[0]!.cells.Lunch![0]!.detail).toBe("2 rotis");
    expect(ben.weeks[0]!.days[0]!.cells.Lunch![0]!.detail).toBe("1 roti");
    expect(asha.audience).toBe("For Asha");
    expect(buildScheduleModel(p, [], { personId: 99 })).toBeUndefined();
  });
  it("says Each when everyone has the same portion, names one person when only they eat", () => {
    const p = plan(7);
    p.meals.forEach((m) => { m.portion = "about 300 g"; });
    expect(buildScheduleModel(p, [])!.weeks[0]!.days[0]!.cells.Lunch![0]!.detail).toBe("Each: 300\u00A0g");
    p.meals = p.meals.filter((m) => !(m.person === "Ben" && m.slot === "Lunch"));
    expect(buildScheduleModel(p, [])!.weeks[0]!.days[0]!.cells.Lunch![0]!.detail).toBe("Asha: 300\u00A0g");
  });
  it("prints the portion alone for a one-person household, and handles no people", () => {
    const solo = plan(7, { people: ["Asha"] });
    expect(buildScheduleModel(solo, [])!.weeks[0]!.days[0]!.cells.Lunch![0]!.detail).toBe("2 rotis");
    expect(buildScheduleModel(solo, [])!.audience).toBe("For Asha");
    const none = { ...solo, people: [] };
    expect(buildScheduleModel(none, [])!.audience).toBe("For everyone");
  });
  it("keeps leftovers apart from fresh meals in the same slot", () => {
    const p = plan(7, { people: ["Asha"] });
    p.meals.push(meal("2026-11-02", "Lunch", "Dal", "Asha", "1 bowl", { leftover: true }));
    const cell = buildScheduleModel(p, [])!.weeks[0]!.days[0]!.cells.Lunch!;
    expect(cell.map((e) => e.leftover)).toEqual([false, true]);
  });
  it("lists prep by the evening it is due, including the night before the first day", () => {
    const tasks: SchedulePrepTask[] = [{ dueDate: "2026-11-01", text: "Soak rajma", forName: "Rajma" }, { dueDate: "2026-11-03", text: "Marinate tofu", forName: "Tofu bowl" }, { dueDate: "2026-11-20", text: "Later", forName: "Other" }];
    expect(buildScheduleModel(plan(7), tasks)!.weeks[0]!.prep.map((x) => [x.dayLabel, x.text])).toEqual([["Sun night", "Rajma: Soak rajma"], ["Tue night", "Tofu bowl: Marinate tofu"]]);
  });
});

describe("clip and fitPrep", () => {
  it("clips on a word with an ellipsis, and leaves short text alone", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("alpha beta gamma delta", 14)).toBe("alpha beta…");
    expect(clip("abcdefghijklmnop", 8)).toBe("abcdefg…");
  });
  it("truncates a long prep list with a count of what is left out", () => {
    const m = buildScheduleModel(plan(7), prepFor(40))!;
    const fit = fitPrep(m.weeks[0]!, 2);
    expect(fit.left).toBeGreaterThan(0);
    expect(fit.runs.length).toBeGreaterThan(0);
    const short = buildScheduleModel(plan(7), prepFor(2))!;
    expect(fitPrep(short.weeks[0]!, 3).left).toBe(0);
  });
  it("clips a single oversized task rather than dropping the strip", () => {
    const m = buildScheduleModel(plan(7), [{ dueDate: "2026-11-02", text: "x ".repeat(2000), forName: "Big" }])!;
    const fit = fitPrep(m.weeks[0]!, 1);
    expect(fit.runs).toHaveLength(2);
    expect(fit.left).toBe(0);
    const none = fitPrep({ ...m.weeks[0]!, prep: [{ dayLabel: "Mon night", text: "y ".repeat(2000) }, { dayLabel: "Tue night", text: "z" }] }, 1);
    expect(none.left).toBe(1);
  });
});

describe("buildSchedulePdf", () => {
  it("fits a normal week on one page and is a real PDF", async () => {
    const m = buildScheduleModel(plan(7), prepFor(6))!;
    const pdf = await buildSchedulePdf(m);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(countPdfPages(pdf)).toBe(1);
  });
  it("fits seven days of very long recipe names on one page", async () => {
    const m = buildScheduleModel(plan(7, { names: (i, slot) => `${LONG} ${slot} ${i}`, shake: true }), prepFor(30))!;
    const pdf = await buildSchedulePdf(m);
    expect(countPdfPages(pdf)).toBe(1);
  });
  it("fits an absurdly long name by cutting it, still on one page", async () => {
    const m = buildScheduleModel(plan(7, { names: () => "Supercalifragilistic ".repeat(40), shake: true }), prepFor(60))!;
    expect(countPdfPages(await buildSchedulePdf(m))).toBe(1);
  });
  it("handles a week with an empty day and no prep", async () => {
    const p = plan(7);
    p.meals = p.meals.filter((x) => x.date !== "2026-11-04");
    expect(countPdfPages(await buildSchedulePdf(buildScheduleModel(p, [])!))).toBe(1);
  });
  it("gives one page per week", async () => {
    const m = buildScheduleModel(plan(21, { names: () => LONG }), prepFor(10))!;
    expect(m.weeks).toHaveLength(3);
    expect(countPdfPages(await buildSchedulePdf(m))).toBe(3);
  });
  it("prints a short last week and a plan that starts mid-week on one page each", async () => {
    const m = buildScheduleModel(plan(10, { start: "2026-11-04" }), [])!;
    expect(m.weeks.map((w) => w.days.length)).toEqual([7, 3]);
    expect(countPdfPages(await buildSchedulePdf(m))).toBe(2);
  });
});

describe("scheduleDefinition", () => {
  const m = buildScheduleModel(plan(7, { shake: true }), prepFor(4))!;
  it("is A4 landscape with margins of at least 24 pt", () => {
    const d = scheduleDefinition(m, FIT_LEVELS[0]!);
    expect(d.pageSize).toBe("A4");
    expect(d.pageOrientation).toBe("landscape");
    expect((d.pageMargins as number[]).every((x) => x >= 24)).toBe(true);
  });
  it("never uses a font under 9 pt, and body text is at least 10 pt except in the last-resort levels", () => {
    for (const level of FIT_LEVELS) {
      const sizes = fontSizes(scheduleDefinition(m, level).content).concat(level.fontSize);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(9);
    }
    const sizes = fontSizes(scheduleDefinition(m, FIT_LEVELS[0]!).content);
    expect(Math.min(...sizes.filter((s) => s !== 9))).toBeGreaterThanOrEqual(10);
  });
  it("uses only black text, so it prints well without colour", () => {
    expect(JSON.stringify(scheduleDefinition(m, FIT_LEVELS[0]!).content)).not.toMatch(/"color":"#(?!000000)/);
  });
  it("estimates smaller rows at smaller levels", () => {
    const week = buildScheduleModel(plan(7, { names: () => LONG }), [])!;
    const h = FIT_LEVELS.map((l) => estimateHeight(week, week.weeks[0]!, l));
    expect(h[h.length - 1]!).toBeLessThan(h[0]!);
    expect(h[h.length - 1]!).toBeLessThan(595.28 - 64);
  });
  it("marks leftovers and empty cells", () => {
    const p = plan(7, { people: ["Asha"] });
    p.meals = p.meals.filter((x) => x.slot !== "Snack");
    p.meals.push(meal("2026-11-02", "Dinner", "Dal", "Asha", "1 bowl", { leftover: true }));
    const text = JSON.stringify(scheduleDefinition(buildScheduleModel(p, [])!, FIT_LEVELS[0]!).content);
    expect(text).toContain("Leftovers: Dal");
    expect(text).toContain('"text":"-"');
  });
});

describe("scheduleUrl", () => {
  it("builds the PDF link for everyone, one person and a download", async () => {
    const { scheduleUrl } = await import("../lib/export/schedule-url");
    expect(scheduleUrl(4, null)).toBe("/api/plan/4/schedule");
    expect(scheduleUrl(4, 9)).toBe("/api/plan/4/schedule?person=9");
    expect(scheduleUrl(4, 9, true)).toBe("/api/plan/4/schedule?person=9&download=1");
    expect(scheduleUrl(4, null, true)).toBe("/api/plan/4/schedule?download=1");
  });
});
