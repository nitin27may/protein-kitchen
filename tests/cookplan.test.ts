import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { buildCookPlan, buyText, estimateHandsOnMin, prepareCook, schedule, waitVerb } from "../lib/recipes/cookplan";
import type { CookInput, CookStep } from "../lib/recipes/cookplan";
import { ADD_MS, extendTimer, formatClock, isDone, minutesLeft, needsAlert, parseTimers, remainingMs, serializeTimers, soonestRunning, startTimer, timersKey } from "../lib/recipes/cooktimers";

const data: DataSet = loadData(process.cwd());
const bowl = data.recipes.get("falafel-bowl")!;
const plan = (modes = {}, opts = {}) => buildCookPlan(bowl, data.recipes, data.ingredients, modes, 2, opts);
const parts = (steps: CookStep[]) => steps.map((s) => s.partSlug);

describe("buildCookPlan, falafel bowl", () => {
  it("includes every part and the meal's own steps, with the meal last", () => {
    const steps = plan();
    const slugs = new Set(parts(steps));
    expect(slugs).toEqual(new Set(["baked-falafel", "hummus", "lemon-tahini-dressing", null]));
    const lastPart = Math.max(...steps.map((s, i) => (s.partSlug ? i : -1)));
    const firstMeal = steps.findIndex((s) => s.partSlug === null);
    expect(firstMeal).toBeGreaterThan(lastPart);
    expect(steps.at(-1)!.partSlug).toBeNull();
    expect(steps.length).toBe(bowl.steps.length + data.recipes.get("baked-falafel")!.steps.length + data.recipes.get("hummus")!.steps.length + data.recipes.get("lemon-tahini-dressing")!.steps.length);
  });

  it("starts with the part that has the most hands-off time", () => {
    expect(plan()[0]!.partSlug).toBe("baked-falafel");
  });

  it("fills the falafel's long timers with the other parts, and says so", () => {
    const steps = plan();
    const hummus = steps.filter((s) => s.partSlug === "hummus");
    expect(hummus.length).toBeGreaterThan(0);
    const lastFalafel = Math.max(...steps.map((s, i) => (s.partSlug === "baked-falafel" ? i : -1)));
    expect(steps.findIndex((s) => s.partSlug === "hummus")).toBeLessThan(lastFalafel);
    expect(hummus.every((s) => s.whileHint?.startsWith("While the baked falafel "))).toBe(true);
    expect(hummus[0]!.whileHint).toMatch(/make the hummus$/);
  });

  it("keeps each part's own steps in their original order", () => {
    const steps = plan();
    for (const slug of ["baked-falafel", "hummus", "lemon-tahini-dressing"]) {
      const texts = steps.filter((s) => s.partSlug === slug).map((s) => s.text);
      expect(texts).toEqual(data.recipes.get(slug)!.steps.map((s) => s.text));
    }
    expect(steps.filter((s) => s.partSlug === null).map((s) => s.text)).toEqual(bowl.steps.map((s) => s.text));
  });

  it("gives every step a unique id that stays the same on a second build", () => {
    const a = plan().map((s) => s.id);
    expect(new Set(a).size).toBe(a.length);
    expect(plan().map((s) => s.id)).toEqual(a);
  });

  it("marks the first step of a part that keeps as make-ahead", () => {
    const first = plan().find((s) => s.partSlug === "hummus")!;
    expect(first.makeAhead).toBe(true);
    expect(plan().filter((s) => s.partSlug === "hummus" && s.makeAhead)).toHaveLength(1);
  });

  it("flags a step with a timer of ten minutes or more as hands-off", () => {
    const bake = plan().find((s) => s.timerSec === 1500)!;
    expect(bake.handsOff).toBe(true);
    expect(plan().find((s) => s.timerSec === 480)!.handsOff).toBe(false);
  });
});

describe("part modes and already made", () => {
  it("leaves out a part marked have", () => {
    const steps = plan({ hummus: "have" });
    expect(parts(steps)).not.toContain("hummus");
    expect(steps.filter((s) => s.partSlug === "lemon-tahini-dressing").length).toBeGreaterThan(0);
  });

  it("turns a part marked buy into one shopping step with no timer, before the cooking", () => {
    const steps = plan({ hummus: "buy" });
    const hummus = steps.filter((s) => s.partSlug === "hummus");
    expect(hummus).toHaveLength(1);
    expect(hummus[0]).toMatchObject({ kind: "buy", timerSec: null, cue: null });
    expect(hummus[0]!.text).toMatch(/^Buy .*hummus/i);
    expect(steps[0]!.partSlug).toBe("hummus");
  });

  it("skips a part marked already made for the session, and rebuilds the hints without it", () => {
    const steps = plan({}, { alreadyMade: ["hummus"] });
    expect(parts(steps)).not.toContain("hummus");
    expect(steps.some((s) => s.whileHint?.includes("hummus"))).toBe(false);
  });

  it("does not change the default plan when nothing is marked", () => {
    expect(plan({}, { alreadyMade: [] }).map((s) => s.id)).toEqual(plan().map((s) => s.id));
  });

  it("builds the same plan from prepared data as from the recipe (client path)", () => {
    const input: CookInput = JSON.parse(JSON.stringify(prepareCook(bowl, data.recipes, data.ingredients, {}, 2)));
    expect(schedule(input, ["hummus"]).map((s) => s.id)).toEqual(plan({}, { alreadyMade: ["hummus"] }).map((s) => s.id));
  });

  it("estimates fewer hands-on minutes when a part is already made", () => {
    const input = prepareCook(bowl, data.recipes, data.ingredients, {}, 2);
    expect(estimateHandsOnMin(input, ["hummus"])).toBe(estimateHandsOnMin(input) - data.recipes.get("hummus")!.active_min);
  });
});

describe("recipes without parts", () => {
  it("returns the recipe's own steps in order", () => {
    const palak = data.recipes.get("palak-paneer")!;
    const steps = buildCookPlan(palak, data.recipes, data.ingredients, {}, 2);
    expect(steps.map((s) => s.text)).toEqual(palak.steps.map((s) => s.text));
    expect(steps.every((s) => s.partSlug === null && s.whileHint === null)).toBe(true);
  });
});

describe("scheduling rules", () => {
  const step = (index: number, timerSec: number | null = null) => ({ index, text: `step ${index}`, cue: null, tip: null, technique: null, timerSec, handsOff: (timerSec ?? 0) >= 600 });
  const track = (slug: string | null, o: Partial<CookInput["tracks"][number]> = {}): CookInput["tracks"][number] => ({ slug, name: slug ?? "Meal", parentSlug: null, kind: slug ? "make" : "meal", keeps: false, activeMin: 6, handsOffSec: 0, order: 0, steps: [step(0), step(1)], ...o });
  const input = (tracks: CookInput["tracks"]): CookInput => ({ recipeSlug: "r", mealName: "R", mealActiveMin: 5, tracks, parts: [] });

  it("makes a part inside a part before the part that uses it", () => {
    const sauce = track("sauce", { parentSlug: "dish", order: 1 });
    const dish = track("dish", { order: 0, handsOffSec: 2000, steps: [step(0, 1200)] });
    const order = schedule(input([dish, sauce, track(null, { order: 2 })])).map((s) => s.partSlug);
    expect(order.indexOf("sauce")).toBeLessThan(order.indexOf("dish"));
  });

  it("drops a part's nested parts when the part is already made", () => {
    const sauce = track("sauce", { parentSlug: "dish", order: 1 });
    const dish = track("dish", { order: 0 });
    const order = schedule(input([dish, sauce, track(null, { order: 2 })]), ["dish"]).map((s) => s.partSlug);
    expect(order).toEqual([null, null]);
  });

  it("only fills as much of a wait as fits, then goes back", () => {
    // The wait is 600 s and one step of "other" is estimated at 600 s (30 min over 3 steps), so exactly one fits.
    const long = track("long", { order: 0, handsOffSec: 600, steps: [step(0, 600), step(1)] });
    const other = track("other", { order: 1, activeMin: 30, steps: [step(0), step(1), step(2)] });
    const order = schedule(input([long, other, track(null, { order: 2 })])).map((s) => `${s.partSlug}:${s.id.split("/").pop()}`);
    expect(order.slice(0, 5)).toEqual(["long:0", "other:0", "long:1", "other:1", "other:2"]);
    expect(order.slice(5)).toEqual(["null:0", "null:1"]);
  });

  it("describes the wait from the step text", () => {
    expect(waitVerb("Bake on an oiled tray at 200°C")).toBe("bakes");
    expect(waitVerb("Soak the chickpeas overnight")).toBe("soaks");
    expect(waitVerb("Stir in besan and rest 15 minutes")).toBe("rests");
    expect(waitVerb("Wait")).toBe("is timing");
  });

  it("words the shopping step without repeating store-bought", () => {
    expect(buyText("Hummus (store-bought)")).toBe("Buy hummus (store-bought).");
    expect(buyText("Tahini")).toBe("Buy store-bought tahini.");
  });
});

describe("timer maths", () => {
  const base = { stepId: "r/p/0", label: "Bake", partName: "Falafel", durationSec: 1500 };

  it("stores an end time and counts down from it", () => {
    const t = startTimer(base, 1_000_000);
    expect(t.endAt).toBe(1_000_000 + 1_500_000);
    expect(remainingMs(t.endAt, 1_000_000)).toBe(1_500_000);
    expect(remainingMs(t.endAt, 1_000_000 + 60_000)).toBe(1_440_000);
    expect(isDone(t.endAt, t.endAt - 1)).toBe(false);
    expect(isDone(t.endAt, t.endAt)).toBe(true);
    expect(remainingMs(t.endAt, t.endAt + 5000)).toBe(0);
  });

  it("is not thrown off by a background gap: remaining follows the clock, not the ticks", () => {
    const t = startTimer(base, 0);
    const before = remainingMs(t.endAt, 10_000);
    const after = remainingMs(t.endAt, 100_000); // the tab slept, the clock jumped 90 s
    expect(before - after).toBe(90_000);
  });

  it("adds five minutes to a running timer and restarts a finished one from now", () => {
    const t = startTimer({ ...base, durationSec: 60 }, 0);
    expect(extendTimer(t, ADD_MS, 10_000).endAt).toBe(60_000 + ADD_MS);
    const done = extendTimer({ ...t, alerted: true }, ADD_MS, 120_000);
    expect(done.endAt).toBe(120_000 + ADD_MS);
    expect(done.alerted).toBe(false);
  });

  it("finds the soonest running timer and the ones that need an alert", () => {
    const a = startTimer({ ...base, stepId: "a", durationSec: 600 }, 0);
    const b = startTimer({ ...base, stepId: "b", durationSec: 60 }, 0);
    expect(soonestRunning([a, b], 1000)!.stepId).toBe("b");
    expect(soonestRunning([a, b], 700_000)).toBeNull();
    expect(needsAlert([a, b], 61_000).map((t) => t.stepId)).toEqual(["b"]);
    expect(needsAlert([a, { ...b, alerted: true }], 61_000)).toEqual([]);
  });

  it("formats the clock, rounding up", () => {
    expect(formatClock(1_500_000)).toBe("25:00");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(1)).toBe("0:01");
    expect(formatClock(0)).toBe("0:00");
    expect(minutesLeft(61_000)).toBe(2);
  });

  it("saves and restores timers, and drops bad data", () => {
    const t = startTimer(base, 5);
    expect(parseTimers(serializeTimers([t]))).toEqual([t]);
    expect(parseTimers("not json")).toEqual([]);
    expect(parseTimers(JSON.stringify([{ id: 1 }, null, 3]))).toEqual([]);
    expect(parseTimers(null)).toEqual([]);
    expect(timersKey("falafel-bowl", 3)).toBe("cook-timers:falafel-bowl:3");
    expect(timersKey("falafel-bowl", null)).toBe("cook-timers:falafel-bowl:none");
  });
});
