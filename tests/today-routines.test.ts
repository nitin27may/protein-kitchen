import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { writePersonRoutine } from "../lib/human/routines";
import { catalogByHabit, getRoutineCatalog } from "../lib/routines/catalog";
import { groupByTimeOfDay, routineDayTotals, routinesForDate, showRoutineLine, withoutRoutineHabits } from "../lib/routines/schedule";
import { readTodayRoutines } from "../lib/server/today-routines";
import type { IsoWeekday, PersonRoutineView } from "../lib/routines/types";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
const catalog = getRoutineCatalog(data);
const options = catalogByHabit(catalog);

// 2026-11-07 is a Saturday, 2026-11-09 a Monday.
const SAT = "2026-11-07";
const MON = "2026-11-09";

const WEEKDAYS: IsoWeekday[] = [1, 2, 3, 4, 5];
const choice = (over: Partial<PersonRoutineView> = {}): PersonRoutineView => ({ habitSlug: "soaked-methi-seeds", active: true, days: [1, 2, 3, 4, 5, 6, 7], timeOfDay: "waking", servings: 1, ...over });

describe("routinesForDate", () => {
  it("leaves out a Monday to Friday routine on a Saturday and keeps an every-day one", () => {
    const chosen = [choice({ habitSlug: "soaked-almonds", days: WEEKDAYS, timeOfDay: "morning" }), choice({ habitSlug: "soaked-methi-seeds" })];
    expect(routinesForDate(chosen, SAT).map((r) => r.habitSlug)).toEqual(["soaked-methi-seeds"]);
    expect(routinesForDate(chosen, MON).map((r) => r.habitSlug)).toEqual(["soaked-methi-seeds", "soaked-almonds"]);
  });

  it("skips routines that are switched off", () => {
    expect(routinesForDate([choice({ active: false })], MON)).toEqual([]);
  });

  it("orders by time of day, then by habit, so the list never jumps", () => {
    const chosen = [
      choice({ habitSlug: "soaked-almonds", timeOfDay: "morning" }),
      choice({ habitSlug: "chia-in-liquid", timeOfDay: "breakfast" }),
      choice({ habitSlug: "saunf-water", timeOfDay: "waking" }),
      choice({ habitSlug: "ajwain-water", timeOfDay: "waking" }),
      choice({ habitSlug: "jeera-methi-water", timeOfDay: "bedtime" }),
    ];
    expect(routinesForDate(chosen, MON).map((r) => r.habitSlug)).toEqual(["ajwain-water", "saunf-water", "soaked-almonds", "chia-in-liquid", "jeera-methi-water"]);
  });
});

describe("groupByTimeOfDay", () => {
  it("groups in day order and leaves out empty groups", () => {
    const groups = groupByTimeOfDay([
      { id: 1, timeOfDay: "breakfast" as const },
      { id: 2, timeOfDay: "waking" as const },
      { id: 3, timeOfDay: "waking" as const },
    ]);
    expect(groups.map((g) => g.time)).toEqual(["waking", "breakfast"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([2, 3]);
  });
  it("returns nothing for nothing", () => {
    expect(groupByTimeOfDay([])).toEqual([]);
  });
});

describe("no duplicate between daily basics and routines", () => {
  it("removes every habit that is a routine, and only those", () => {
    const basics = withoutRoutineHabits(data.habits, catalog);
    const routineSlugs = new Set(catalog.map((o) => o.habitSlug));
    expect(basics.some((h) => routineSlugs.has(h.slug))).toBe(false);
    expect(basics.length).toBe(data.habits.length - catalog.length);
    // The routine habits are exactly the habits that carry a routine block.
    expect([...routineSlugs].sort()).toEqual(data.habits.filter((h) => h.routine).map((h) => h.slug).sort());
  });
  it("keeps non-routine basics such as ground flaxseed", () => {
    expect(withoutRoutineHabits(data.habits, catalog).map((h) => h.slug)).toContain("ground-flax-daily");
  });
});

describe("today's routines against a real database", () => {
  let h: DbHandle;
  let personId: number;
  const habitId = async (slug: string) => (await h.db.select({ id: s.habits.id }).from(s.habits).where(eq(s.habits.slug, slug)))[0]!.id;
  const choose = async (slug: string, over: Partial<PersonRoutineView> = {}) =>
    writePersonRoutine(h.db, personId, await habitId(slug), { active: true, days: [1, 2, 3, 4, 5, 6, 7], timeOfDay: "waking", servings: 1, ...over });

  beforeEach(async () => {
    h = openDb(":memory:", path.join(root, "db", "migrations"));
    await seedDatabase(h.db, data);
    const [p] = await h.db.insert(s.people).values({ name: "Test", sex: "male", birthDate: "1985-01-01", heightCm: 180, weightKg: 80, activityLevel: "moderate", proteinGPerKg: 1.5, dietFlags: [] }).returning({ id: s.people.id });
    personId = p!.id;
  });

  it("is empty when the person chose nothing", async () => {
    expect(await readTodayRoutines(h.db, personId, MON)).toEqual([]);
  });

  it("lists the routines scheduled on that weekday, in time order, not ticked", async () => {
    await choose("soaked-almonds", { days: WEEKDAYS, timeOfDay: "morning" });
    await choose("soaked-methi-seeds");
    expect(await readTodayRoutines(h.db, personId, MON)).toEqual([
      { habitSlug: "soaked-methi-seeds", timeOfDay: "waking", servings: 1, done: false },
      { habitSlug: "soaked-almonds", timeOfDay: "morning", servings: 1, done: false },
    ]);
    expect((await readTodayRoutines(h.db, personId, SAT)).map((r) => r.habitSlug)).toEqual(["soaked-methi-seeds"]);
  });

  it("reads the done state from habit_log for that date and person only", async () => {
    await choose("soaked-methi-seeds");
    await choose("saunf-water");
    const methi = await habitId("soaked-methi-seeds");
    await h.db.insert(s.habitLog).values({ date: MON, personId, habitId: methi, done: true });
    // A tick on another day, and an un-tick, must not count.
    await h.db.insert(s.habitLog).values({ date: SAT, personId, habitId: await habitId("saunf-water"), done: true });
    const [other] = await h.db.insert(s.people).values({ name: "Other", sex: "female", birthDate: "1986-01-01", heightCm: 165, weightKg: 60, activityLevel: "moderate", proteinGPerKg: 1.2, dietFlags: [] }).returning({ id: s.people.id });
    await h.db.insert(s.habitLog).values({ date: MON, personId: other!.id, habitId: await habitId("saunf-water"), done: true });

    const mon = await readTodayRoutines(h.db, personId, MON);
    expect(Object.fromEntries(mon.map((r) => [r.habitSlug, r.done]))).toEqual({ "saunf-water": false, "soaked-methi-seeds": true });
    const sat = await readTodayRoutines(h.db, personId, SAT);
    expect(Object.fromEntries(sat.map((r) => [r.habitSlug, r.done]))).toEqual({ "saunf-water": true, "soaked-methi-seeds": false });
  });

  it("treats a ticked then unticked routine as not done", async () => {
    await choose("soaked-methi-seeds");
    await h.db.insert(s.habitLog).values({ date: MON, personId, habitId: await habitId("soaked-methi-seeds"), done: false });
    expect((await readTodayRoutines(h.db, personId, MON))[0]!.done).toBe(false);
  });

  it("ignores a routine that was switched off", async () => {
    await choose("soaked-methi-seeds", { active: false });
    expect(await readTodayRoutines(h.db, personId, MON)).toEqual([]);
  });
});

describe("what routines add to a day", () => {
  it("is above zero for a routine with calories and shows per person, per date", () => {
    const choices = [{ habitSlug: "soaked-almonds", days: WEEKDAYS, servings: 1, personId: 1 }, { habitSlug: "soaked-almonds", days: WEEKDAYS, servings: 2, personId: 2 }];
    const totals = routineDayTotals(choices, [MON, SAT], options, data.recipes, data.ingredients);
    expect(totals[MON]![1]!.kcal).toBeGreaterThan(0);
    expect(totals[MON]![1]!.protein_g).toBeGreaterThan(0);
    expect(totals[MON]![2]!.kcal).toBeCloseTo(totals[MON]![1]!.kcal * 2, 5);
    // Saturday is outside Monday to Friday, so there is no entry at all.
    expect(totals[SAT]).toBeUndefined();
  });

  it("counts almonds as clearly more than seeds in a glass of water, and both are honest non-negative totals", () => {
    const almonds = routineDayTotals([{ habitSlug: "soaked-almonds", days: WEEKDAYS, servings: 1, personId: 1 }], [MON], options, data.recipes, data.ingredients)[MON]![1]!;
    const methi = routineDayTotals([{ habitSlug: "soaked-methi-seeds", days: [1 as IsoWeekday], servings: 1, personId: 1 }], [MON], options, data.recipes, data.ingredients)[MON]![1]!;
    expect(almonds.kcal).toBeGreaterThan(methi.kcal);
    expect(almonds.protein_g).toBeGreaterThan(methi.protein_g);
    expect(methi.kcal).toBeGreaterThan(0);
    expect(showRoutineLine({ proteinG: almonds.protein_g, kcal: almonds.kcal })).toBe(true);
  });

  it("showRoutineLine thresholds", () => {
    expect(showRoutineLine(null)).toBe(false);
    expect(showRoutineLine({ proteinG: 0, kcal: 6 })).toBe(false);
    expect(showRoutineLine({ proteinG: 0, kcal: 10 })).toBe(true);
    expect(showRoutineLine({ proteinG: 0.5, kcal: 3 })).toBe(true);
  });
});
