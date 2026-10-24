import { describe, expect, it } from "vitest";
import type { FeasibilityResult } from "../lib/planner/feasibility-types";
import {
  blockers,
  canSkip,
  dateProblem,
  draftDayCount,
  draftEnd,
  feasibilityKey,
  firstInvalidStep,
  nextStep,
  openingStep,
  parseDraft,
  parseStep,
  prevStep,
  serializeDraft,
  shakeFix,
  stepNumber,
  toCreatePlanInput,
  toFeasibilityInput,
  validateStep,
  withShake,
  WIZARD_STEPS,
} from "../lib/plan/wizard";
import type { WizardDraft } from "../lib/plan/wizard";

const draft = (patch: Partial<WizardDraft> = {}): WizardDraft => ({
  personIds: [1],
  length: "7",
  start: "2026-11-02",
  customEnd: "2026-11-04",
  shoppingDay: null,
  prepDay: null,
  meals: ["breakfast", "lunch", "dinner", "snack"],
  prepStyle: "leftovers",
  timeLimit: "weeknights",
  cuisine: 0.6,
  health: { nutrientDense: true, lowSugar: true, light: true },
  pinned: [],
  prefs: { 1: { liked: ["paneer"], avoided: [] } },
  ...patch,
});

const feasibility = (patch: Partial<FeasibilityResult> = {}): FeasibilityResult => ({
  slots: [
    { slot: "breakfast", eligible: 9, total: 12, bestProteinG: 30, medianProteinG: 20 },
    { slot: "lunch", eligible: 14, total: 20, bestProteinG: 35, medianProteinG: 26 },
  ],
  people: [{ personId: 1, name: "Nitin", targetG: 112, typicalG: 98, bestG: 125, status: "tight" }],
  notes: [],
  ...patch,
});

describe("step order", () => {
  it("runs who, meals, food, routine, review", () => {
    expect([...WIZARD_STEPS]).toEqual(["who", "meals", "food", "routine", "review"]);
    expect(stepNumber("who")).toBe(1);
    expect(stepNumber("review")).toBe(5);
  });

  it("moves forward and back, and stops at the ends", () => {
    expect(nextStep("who")).toBe("meals");
    expect(nextStep("routine")).toBe("review");
    expect(nextStep("review")).toBeNull();
    expect(prevStep("meals")).toBe("who");
    expect(prevStep("who")).toBeNull();
  });

  it("lets every step be skipped except the first and the review", () => {
    expect(canSkip("who")).toBe(false);
    expect(canSkip("meals")).toBe(true);
    expect(canSkip("food")).toBe(true);
    expect(canSkip("routine")).toBe(true);
    expect(canSkip("review")).toBe(false);
  });

  it("reads ?step= and ignores anything else", () => {
    expect(parseStep("food")).toBe("food");
    expect(parseStep("nonsense")).toBeNull();
    expect(parseStep(null)).toBeNull();
    expect(parseStep(undefined)).toBeNull();
  });

  it("opens on the review for a repeat run and on step one for a first run, unless a step is asked for", () => {
    expect(openingStep(null, true)).toBe("review");
    expect(openingStep(null, false)).toBe("who");
    expect(openingStep("meals", true)).toBe("meals");
    expect(openingStep("bogus", true)).toBe("review");
  });
});

describe("dates", () => {
  it("ends a 7 day plan six days after the start and a 14 day plan thirteen days after", () => {
    expect(draftEnd(draft({ length: "7" }))).toBe("2026-11-08");
    expect(draftEnd(draft({ length: "14" }))).toBe("2026-11-15");
    expect(draftDayCount(draft({ length: "7" }))).toBe(7);
  });

  it("uses the custom end only for a custom length", () => {
    expect(draftEnd(draft({ length: "custom", customEnd: "2026-11-04" }))).toBe("2026-11-04");
    expect(draftDayCount(draft({ length: "custom", customEnd: "2026-11-04" }))).toBe(3);
  });

  it("explains a missing start, an end before the start, and a plan that is too long", () => {
    expect(dateProblem(draft({ start: "" }))).toBe("Choose a start date.");
    expect(dateProblem(draft({ length: "custom", customEnd: "2026-11-01" }))).toBe("The end date is before the start date.");
    expect(dateProblem(draft({ length: "custom", customEnd: "2026-12-31" }))).toMatch(/at most 31 days/);
    expect(dateProblem(draft())).toBeNull();
  });
});

describe("validateStep", () => {
  it("needs at least one person and valid dates on the first step", () => {
    expect(validateStep("who", draft())).toEqual([]);
    expect(validateStep("who", draft({ personIds: [] })).map((p) => p.field)).toEqual(["people"]);
    expect(validateStep("who", draft({ start: "" })).map((p) => p.field)).toEqual(["dates"]);
    expect(validateStep("who", draft({ personIds: [], start: "" })).map((p) => p.field)).toEqual(["people", "dates"]);
  });

  it("needs at least one meal type on the meals step", () => {
    expect(validateStep("meals", draft({ meals: [] })).map((p) => p.message)).toEqual(["Choose at least one meal type."]);
    expect(validateStep("meals", draft())).toEqual([]);
  });

  it("has nothing to check on food and routine, and checks everything on review", () => {
    expect(validateStep("food", draft({ personIds: [], meals: [] }))).toEqual([]);
    expect(validateStep("routine", draft({ personIds: [], meals: [] }))).toEqual([]);
    expect(validateStep("review", draft({ personIds: [], meals: [] })).map((p) => p.field)).toEqual(["people", "meals"]);
  });

  it("finds the first step that needs fixing", () => {
    expect(firstInvalidStep(draft())).toBeNull();
    expect(firstInvalidStep(draft({ meals: [] }))).toBe("meals");
    expect(firstInvalidStep(draft({ personIds: [], meals: [] }))).toBe("who");
  });
});

describe("blockers", () => {
  it("is empty for a good draft with a reachable answer", () => {
    expect(blockers(draft(), feasibility())).toEqual([]);
    expect(blockers(draft(), null)).toEqual([]);
  });

  it("reports draft problems before the planner has answered", () => {
    expect(blockers(draft({ meals: [] }), null)).toEqual(["Choose at least one meal type."]);
  });

  it("blocks a requested meal type that has no recipe left", () => {
    const f = feasibility({ slots: [{ slot: "breakfast", eligible: 0, total: 12, bestProteinG: 0, medianProteinG: 0 }] });
    const out = blockers(draft(), f);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/No breakfast recipes fit/);
  });

  it("ignores an empty slot that was not asked for", () => {
    const f = feasibility({ slots: [{ slot: "shake", eligible: 0, total: 1, bestProteinG: 0, medianProteinG: 0 }] });
    expect(blockers(draft(), f)).toEqual([]);
  });

  it("lets a person who is only short go ahead, but not one with no way to reach any protein", () => {
    const short = feasibility({ people: [{ personId: 1, name: "Nitin", targetG: 112, typicalG: 70, bestG: 90, status: "short" }] });
    expect(blockers(draft(), short)).toEqual([]);
    const none = feasibility({ people: [{ personId: 1, name: "Nitin", targetG: 112, typicalG: 0, bestG: 0, status: "short" }] });
    expect(blockers(draft(), none)[0]).toMatch(/Nitin has no recipes/);
  });
});

describe("shake fix", () => {
  const tight = feasibility({ notes: ["A daily shake would close the gap."] });

  it("is offered when someone is tight or short, a note mentions a shake, and shake is off", () => {
    expect(shakeFix(draft(), tight)).toBe(true);
  });

  it("is not offered when shake is already on, everyone is fine, or the planner did not say so", () => {
    expect(shakeFix(draft({ meals: ["breakfast", "shake"] }), tight)).toBe(false);
    const fine = feasibility({ people: [{ personId: 1, name: "Nitin", targetG: 112, typicalG: 120, bestG: 140, status: "reachable" }], notes: ["A shake would add more."] });
    expect(shakeFix(draft(), fine)).toBe(false);
    expect(shakeFix(draft(), feasibility())).toBe(false);
    expect(shakeFix(draft(), null)).toBe(false);
  });

  it("adds a shake once", () => {
    expect(withShake(draft()).meals).toContain("shake");
    expect(withShake(withShake(draft())).meals.filter((m) => m === "shake")).toHaveLength(1);
  });
});

describe("mapping to the actions", () => {
  it("builds the feasibility input with the active time limit and the people's preferences", () => {
    const input = toFeasibilityInput(draft({ timeLimit: "always20", personIds: [1, 2], prefs: { 1: { liked: ["paneer"], avoided: [] } } }));
    expect(input.maxActiveMin).toBe(20);
    expect(input.endDate).toBe("2026-11-08");
    expect(input.prefs["1"]).toEqual({ liked: ["paneer"], avoided: [] });
    expect(input.prefs["2"]).toEqual({ liked: [], avoided: [] });
    expect(toFeasibilityInput(draft({ timeLimit: "none" })).maxActiveMin).toBe(999);
    expect(toFeasibilityInput(draft({ timeLimit: "weeknights" })).maxActiveMin).toBeNull();
  });

  it("adds the shopping and prep day to the create input", () => {
    const input = toCreatePlanInput(draft({ shoppingDay: 6, prepDay: 7 }));
    expect(input.shoppingDay).toBe(6);
    expect(input.prepDay).toBe(7);
    expect(toCreatePlanInput(draft()).shoppingDay).toBeNull();
  });

  it("changes the feasibility key when a choice that matters changes, and not when one that does not changes", () => {
    const base = feasibilityKey(draft());
    expect(feasibilityKey(draft({ cuisine: 0.2 }))).not.toBe(base);
    expect(feasibilityKey(draft({ meals: ["lunch"] }))).not.toBe(base);
    expect(feasibilityKey(draft({ shoppingDay: 6 }))).toBe(base);
  });
});

describe("draft storage", () => {
  const fallback = draft({ meals: ["breakfast"], start: "2026-11-09" });

  it("round trips a draft", () => {
    const d = draft({ shoppingDay: 6, pinned: ["palak-paneer"], meals: ["lunch", "shake"], length: "custom", customEnd: "2026-11-05" });
    expect(parseDraft(serializeDraft(d), fallback)).toEqual(d);
  });

  it("falls back on bad JSON, an empty value, another version, or the wrong shape", () => {
    expect(parseDraft("{not json", fallback)).toBe(fallback);
    expect(parseDraft(null, fallback)).toBe(fallback);
    expect(parseDraft("", fallback)).toBe(fallback);
    expect(parseDraft(JSON.stringify({ v: 99, draft: draft() }), fallback)).toBe(fallback);
    expect(parseDraft(JSON.stringify([1, 2]), fallback)).toBe(fallback);
    expect(parseDraft(JSON.stringify({ v: 1, draft: "x" }), fallback)).toBe(fallback);
  });

  it("keeps good fields and replaces only the bad ones", () => {
    const stored = JSON.stringify({ v: 1, draft: { ...draft({ cuisine: 0.3 }), meals: "oops", length: "30" } });
    const out = parseDraft(stored, fallback);
    expect(out.cuisine).toBe(0.3);
    expect(out.meals).toEqual(fallback.meals);
    expect(out.length).toBe(fallback.length);
  });

  it("drops meal types that do not exist and a start date that is not a date", () => {
    const stored = JSON.stringify({ v: 1, draft: { ...draft(), meals: ["lunch", "brunch"], start: "next monday" } });
    const out = parseDraft(stored, fallback);
    expect(out.meals).toEqual(["lunch"]);
    expect(out.start).toBe(fallback.start);
  });

  it("drops people who no longer exist, and their preferences", () => {
    const stored = serializeDraft(draft({ personIds: [1, 2, 3], prefs: { 1: { liked: ["paneer"], avoided: [] }, 3: { liked: ["tofu"], avoided: [] } } }));
    const out = parseDraft(stored, fallback, [1, 2]);
    expect(out.personIds).toEqual([1, 2]);
    expect(Object.keys(out.prefs)).toEqual(["1"]);
  });

  it("uses the fallback people when none of the saved ones exist any more", () => {
    const out = parseDraft(serializeDraft(draft({ personIds: [9] })), fallback, [1]);
    expect(out.personIds).toEqual(fallback.personIds);
  });
});
