import { describe, expect, it } from "vitest";
import { MAX_PLAN_DAYS, PersonSchema, planDays, PlanSetupSchema } from "../lib/schemas";

const setup = {
  person_ids: ["p1"],
  start_date: "2026-11-03",
  end_date: "2026-11-09",
  meal_types: ["breakfast", "lunch", "dinner"],
  cuisine_balance: 0.5,
  pinned_recipes: [],
};

describe("planDays", () => {
  it("counts both ends", () => {
    expect(planDays("2026-11-03", "2026-11-09")).toBe(7);
    expect(planDays("2026-11-03", "2026-11-03")).toBe(1);
  });
  it("is not skewed by the daylight saving change", () => {
    expect(planDays("2026-11-01", "2026-11-02")).toBe(2);
  });
});

describe("PlanSetupSchema", () => {
  it("accepts a 7 day plan and a 14 day plan", () => {
    expect(PlanSetupSchema.safeParse(setup).success).toBe(true);
    expect(PlanSetupSchema.safeParse({ ...setup, end_date: "2026-11-16" }).success).toBe(true);
  });
  it("accepts a custom range up to the cap and rejects beyond it", () => {
    expect(PlanSetupSchema.safeParse({ ...setup, end_date: "2026-12-03" }).success).toBe(true);
    expect(planDays("2026-11-03", "2026-12-03")).toBe(MAX_PLAN_DAYS);
    expect(PlanSetupSchema.safeParse({ ...setup, end_date: "2026-12-04" }).success).toBe(false);
  });
  it("rejects an end date before the start", () => {
    expect(PlanSetupSchema.safeParse({ ...setup, end_date: "2026-11-01" }).success).toBe(false);
  });
  it("needs at least one person and one meal type", () => {
    expect(PlanSetupSchema.safeParse({ ...setup, person_ids: [] }).success).toBe(false);
    expect(PlanSetupSchema.safeParse({ ...setup, meal_types: [] }).success).toBe(false);
  });
});

describe("PersonSchema", () => {
  const person = {
    id: "p1",
    name: "Nitin",
    sex: "male",
    birth_date: "1986-04-10",
    height_cm: 183,
    weight_kg: 93,
    activity_level: "moderate",
    protein_g_per_kg: 1.3,
    diet_flags: [],
    liked_ingredients: ["paneer"],
    avoided_ingredients: [],
  };
  it("accepts a reminder time and rejects a bad one", () => {
    expect(PersonSchema.safeParse({ ...person, reminder_time: "21:00" }).success).toBe(true);
    expect(PersonSchema.safeParse({ ...person, reminder_time: "25:00" }).success).toBe(false);
  });
  it("accepts a per-kg target or a fixed target, not both or neither", () => {
    expect(PersonSchema.safeParse(person).success).toBe(true);
    expect(PersonSchema.safeParse({ ...person, protein_g_per_kg: undefined, protein_target_g: 120 }).success).toBe(true);
    expect(PersonSchema.safeParse({ ...person, protein_target_g: 120 }).success).toBe(false);
    expect(PersonSchema.safeParse({ ...person, protein_g_per_kg: undefined }).success).toBe(false);
  });
});
