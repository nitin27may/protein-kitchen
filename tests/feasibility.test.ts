import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { buildCandidates } from "../lib/planner/candidates";
import { computeFeasibility } from "../lib/planner/feasibility";
import type { FeasibilityInput } from "../lib/planner/feasibility-types";
import type { Candidate, PersonTarget } from "../lib/planner/types";

const root = path.resolve(__dirname, "..");
const data = loadData(root);
const candidates = buildCandidates(data);

const person = (over: Partial<PersonTarget> = {}): PersonTarget => ({ id: "1", name: "Test", proteinTargetG: 112, kcalTarget: null, liked: new Set(), avoided: new Set(), ...over });
const input = (over: Partial<FeasibilityInput> = {}): FeasibilityInput => ({
  personIds: [1],
  startDate: "2026-11-02", // a Monday
  endDate: "2026-11-08",
  mealTypes: ["breakfast", "lunch", "dinner", "snack"],
  cuisineBalance: 0.6,
  maxActiveMin: null,
  pinned: [],
  healthFocus: { nutrientDense: true, lowSugar: true, light: true },
  prepStyle: "leftovers",
  prefs: {},
  ...over,
});

/** A small hand-made recipe, so the arithmetic in the tests is easy to follow. */
function cand(slug: string, slot: string, proteinG: number, over: Partial<Candidate> = {}): Candidate {
  return {
    slug,
    name: slug,
    family: slot === "shake" ? "shakes" : "bowls",
    mealSlots: [slot],
    isIndian: true,
    activeMin: 10,
    makeAheadMin: 0,
    perServing: { kcal: proteinG * 10, protein_g: proteinG, carbs_g: 20, fat_g: 5, fibre_g: 3 },
    anchors: [],
    ingredients: new Set(["x"]),
    lowSugar: true,
    light: true,
    nutrientDense: false,
    freeSugarG: 0,
    nutrientScore: 0,
    batchFriendly: true,
    fridgeDays: 3,
    favourite: false,
    banned: false,
    rating: null,
    tested: false,
    ...over,
  };
}

describe("computeFeasibility on the real library", () => {
  it("a 112 g target is reachable or tight with the default four meals, and has options in every slot", () => {
    const r = computeFeasibility(input(), candidates, [person()]);
    expect(r.slots.map((s) => s.slot)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    for (const s of r.slots) {
      expect(s.total).toBeGreaterThan(0);
      expect(s.eligible).toBeGreaterThan(0);
      expect(s.eligible).toBeLessThanOrEqual(s.total);
      expect(s.bestProteinG).toBeGreaterThanOrEqual(s.medianProteinG);
    }
    expect(r.people).toHaveLength(1);
    expect(r.people[0]!.targetG).toBe(112);
    expect(["reachable", "tight"]).toContain(r.people[0]!.status);
    expect(r.people[0]!.bestG).toBeGreaterThanOrEqual(r.people[0]!.typicalG);
  });

  it("stays reachable or tight with a shake, and a shake does not lower the best day", () => {
    const without = computeFeasibility(input(), candidates, [person()]);
    const withShake = computeFeasibility(input({ mealTypes: ["breakfast", "lunch", "dinner", "snack", "shake"] }), candidates, [person()]);
    expect(withShake.slots.map((s) => s.slot)).toContain("shake");
    expect(["reachable", "tight"]).toContain(withShake.people[0]!.status);
    // Shares shrink when a slot is added, so compare the best day against the same person's target, not slot by slot.
    expect(withShake.people[0]!.bestG).toBeGreaterThanOrEqual(without.people[0]!.targetG * 0.9);
  });

  it("avoiding paneer and tofu reduces the recipes that pass and never adds any", () => {
    const base = computeFeasibility(input(), candidates, [person()]);
    const avoiding = computeFeasibility(input(), candidates, [person({ avoided: new Set(["paneer", "tofu-extra-firm"]) })]);
    for (const s of avoiding.slots) expect(s.eligible).toBeLessThanOrEqual(base.slots.find((b) => b.slot === s.slot)!.eligible);
    expect(avoiding.slots.reduce((n, s) => n + s.eligible, 0)).toBeLessThan(base.slots.reduce((n, s) => n + s.eligible, 0));
  });

  it("avoiding every ingredient leaves no recipes, says so for each slot, and is short", () => {
    const everything = new Set(candidates.flatMap((c) => [...c.ingredients]));
    const r = computeFeasibility(input(), candidates, [person({ avoided: everything })]);
    for (const s of r.slots) expect(s.eligible).toBe(0);
    for (const slot of ["breakfast", "lunch", "dinner", "snack"]) expect(r.notes).toContain(`No recipes pass for ${slot}.`);
    expect(r.people[0]!.status).toBe("short");
    expect(r.people[0]!.typicalG).toBe(0);
    expect(r.people[0]!.bestG).toBe(0);
  });

  it("never reports a number as a dose: notes are plain sentences about recipes and shakes", () => {
    const r = computeFeasibility(input({ mealTypes: ["lunch"] }), candidates, [person({ proteinTargetG: 150 })]);
    for (const n of r.notes) expect(n).not.toMatch(/\b\d+\s?(mg|g|ml|tsp|tbsp)\b/i);
  });
});

describe("computeFeasibility on hand-made recipes", () => {
  const dinners = [cand("d1", "dinner", 30), cand("d2", "dinner", 35), cand("d3", "dinner", 40), cand("d4", "dinner", 45), cand("d5", "dinner", 50)];

  it("labels the status from the typical and best day", () => {
    // One slot takes the whole day, so a 40 g target is met by the median dinner; 60 g only by the best; 200 g by neither.
    const run = (target: number) => computeFeasibility(input({ mealTypes: ["dinner"] }), dinners, [person({ proteinTargetG: target })]).people[0]!;
    expect(run(40).status).toBe("reachable");
    expect(run(80).status).toBe("tight");
    expect(run(200).status).toBe("short");
  });

  it("adds a note when fewer than five recipes pass, and names avoids as the cause", () => {
    const withIngredient = dinners.map((c, i) => (i < 3 ? { ...c, ingredients: new Set(["paneer"]) } : c));
    const r = computeFeasibility(input({ mealTypes: ["dinner"] }), withIngredient, [person({ avoided: new Set(["paneer"]) })]);
    expect(r.slots[0]!.eligible).toBe(2);
    expect(r.notes).toContain("Only 2 dinners pass your avoids.");
  });

  it("says 'choices' when the time limit, not an avoid, is the cause", () => {
    const slow = dinners.map((c, i) => (i < 3 ? { ...c, activeMin: 45 } : c));
    const r = computeFeasibility(input({ mealTypes: ["dinner"] }), slow, [person()]);
    expect(r.slots[0]!.eligible).toBe(2);
    expect(r.notes).toContain("Only 2 dinners pass your choices.");
  });

  it("uses singular wording for one recipe", () => {
    const r = computeFeasibility(input({ mealTypes: ["dinner"] }), [cand("only", "dinner", 30)], [person()]);
    expect(r.notes).toContain("Only 1 dinner passes your choices.");
  });

  it("applies the 20 minute weeknight limit only when no limit is chosen", () => {
    const longDinner = [cand("slow", "dinner", 40, { activeMin: 35 })];
    expect(computeFeasibility(input({ mealTypes: ["dinner"] }), longDinner, [person()]).slots[0]!.eligible).toBe(0);
    expect(computeFeasibility(input({ mealTypes: ["dinner"], maxActiveMin: 999 }), longDinner, [person()]).slots[0]!.eligible).toBe(1);
    // A plan of one Saturday has no weeknight, so nothing limits it.
    expect(computeFeasibility(input({ mealTypes: ["dinner"], startDate: "2026-11-07", endDate: "2026-11-07" }), longDinner, [person()]).slots[0]!.eligible).toBe(1);
  });

  it("suggests a shake only when it would close the gap and the shake is off", () => {
    const lunch = [cand("l1", "lunch", 20)];
    const shakes = [cand("s1", "shake", 30)];
    const off = computeFeasibility(input({ mealTypes: ["lunch"] }), [...lunch, ...shakes], [person({ proteinTargetG: 60 })]);
    expect(off.people[0]!.status).toBe("short");
    expect(off.notes).toContain("Turning on a shake would close the gap.");
    const on = computeFeasibility(input({ mealTypes: ["lunch", "shake"] }), [...lunch, ...shakes], [person({ proteinTargetG: 60 })]);
    expect(on.notes).not.toContain("Turning on a shake would close the gap.");
    // A target no shake can close gets no suggestion.
    const hopeless = computeFeasibility(input({ mealTypes: ["lunch"] }), [...lunch, ...shakes], [person({ proteinTargetG: 400 })]);
    expect(hopeless.notes).not.toContain("Turning on a shake would close the gap.");
  });

  it("does not change its inputs", () => {
    const people = [person({ avoided: new Set(["paneer"]) })];
    const before = JSON.stringify({ input: input(), people: [...people[0]!.avoided] });
    computeFeasibility(input(), candidates, people);
    expect(JSON.stringify({ input: input(), people: [...people[0]!.avoided] })).toBe(before);
  });

  it("gives each person their own reach from the same recipes", () => {
    const r = computeFeasibility(input({ mealTypes: ["dinner"], personIds: [1, 2] }), dinners, [person({ id: "1", proteinTargetG: 40 }), person({ id: "2", name: "Second", proteinTargetG: 200 })]);
    expect(r.people.map((p) => p.personId)).toEqual([1, 2]);
    expect(r.people.map((p) => p.status)).toEqual(["reachable", "short"]);
  });
});
