import { describe, expect, it } from "vitest";
import { canSave, validateLabel, type LabelInput } from "@/lib/foods/validate";

const codes = (i: LabelInput) => validateLabel(i).issues.map((x) => x.code);

const pancake: LabelInput = {
  basis: "per_serving",
  servingSize: 55,
  servingUnit: "g",
  energy: { value: 190, unit: "kcal" },
  protein_g: 4,
  carbs_g: 40,
  fat_g: 1,
  fibre_g: 1,
  sodium: 380,
  sodiumUnit: "mg",
};

describe("validateLabel: clean labels", () => {
  it("accepts the Costco pancake mix label", () => {
    const r = validateLabel(pancake);
    expect(r.issues).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.needsConfirmation).toBe(false);
    expect(canSave(r, false)).toBe(true);
  });
  it("accepts a sparse label with only some fields", () => {
    expect(validateLabel({ basis: "per_100g" }).issues).toEqual([]);
  });
});

describe("validateLabel: errors", () => {
  it("negative values", () => {
    const r = validateLabel({ ...pancake, protein_g: -1, servingSize: -5 });
    expect(r.errors.map((e) => [e.field, e.code])).toEqual(expect.arrayContaining([["protein_g", "negative_value"], ["servingSize", "negative_value"]]));
    expect(r.blocked).toBe(true);
  });
  it("non-finite values", () => {
    expect(codes({ basis: "per_100g", sodium: Number.NaN })).toEqual(["invalid_number"]);
  });
  it("per 100 g macro above 100", () => {
    const r = validateLabel({ basis: "per_100g", protein_g: 101 });
    expect(r.errors.map((e) => e.code)).toContain("macro_over_100");
    expect(r.errors.find((e) => e.code === "macro_over_100")?.message).toBe("Protein cannot be more than 100 g per 100 g.");
  });
  it("macro above 100 per 100 g once converted from a serving", () => {
    expect(codes({ basis: "per_serving", servingSize: 20, servingUnit: "g", carbs_g: 21 })).toContain("macro_over_100");
  });
  it("macros summing above 105 g per 100 g", () => {
    const r = validateLabel({ basis: "per_100g", protein_g: 40, carbs_g: 40, fat_g: 30 });
    expect(r.errors.map((e) => e.code)).toEqual(["macro_sum_over_105"]);
  });
  it("macros summing to exactly 105 pass", () => {
    expect(codes({ basis: "per_100g", protein_g: 35, carbs_g: 35, fat_g: 35 })).toEqual([]);
  });
  it("more than 950 kcal per 100 g, including from kJ", () => {
    expect(codes({ basis: "per_100g", energy: { value: 951, unit: "kcal" } })).toEqual(["kcal_over_950"]);
    expect(codes({ basis: "per_100g", energy: { value: 4000, unit: "kJ" } })).toEqual(["kcal_over_950"]);
    expect(codes({ basis: "per_100g", energy: { value: 950, unit: "kcal" } })).toEqual([]);
  });
  it("serving size outside 1-1000", () => {
    expect(codes({ basis: "per_100g", servingSize: 0.5, servingUnit: "g" })).toEqual(["serving_size_range"]);
    expect(codes({ basis: "per_100g", servingSize: 1001, servingUnit: "ml" })).toEqual(["serving_size_range"]);
    expect(validateLabel({ basis: "per_100g", servingSize: 1001, servingUnit: "ml" }).errors[0]?.message).toContain("ml");
    expect(validateLabel({ basis: "per_100g", servingSize: 2000 }).errors[0]?.message).toContain("1000 g");
    expect(codes({ basis: "per_100g", servingSize: 1 })).toEqual([]);
    expect(codes({ basis: "per_100g", servingSize: 1000 })).toEqual([]);
  });
  it("per-serving basis without serving size", () => {
    expect(codes({ basis: "per_serving", protein_g: 4, energy: { value: 100, unit: "kcal" } })).toEqual(["serving_size_missing"]);
  });
  it("protein per serving larger than the serving", () => {
    const r = validateLabel({ basis: "per_serving", servingSize: 5, servingUnit: "g", protein_g: 6 });
    expect(r.errors.map((e) => e.code)).toContain("protein_exceeds_serving");
  });
  it("skips per-100 checks when the serving size is unusable", () => {
    expect(codes({ basis: "per_serving", servingSize: -1, protein_g: 500, energy: { value: 5000, unit: "kcal" } })).toEqual(["negative_value"]);
  });
  it("a bad energy value is skipped by the energy checks", () => {
    expect(codes({ basis: "per_100g", energy: { value: -5, unit: "kcal" }, protein_g: 5, carbs_g: 5, fat_g: 5 })).toEqual(["negative_value"]);
  });
});

describe("validateLabel: warnings", () => {
  it("energy inconsistent with macros mentions polyols", () => {
    const r = validateLabel({ basis: "per_100g", energy: { value: 150, unit: "kcal" }, protein_g: 5, carbs_g: 40, fat_g: 5 });
    expect(r.warnings.map((w) => w.code)).toEqual(["energy_macro_mismatch"]);
    expect(r.warnings[0]?.message).toMatch(/polyols/);
    expect(r.needsConfirmation).toBe(true);
    expect(r.blocked).toBe(false);
  });
  it("energy within tolerance passes (15 percent)", () => {
    // estimate = 4*5+4*40+9*5 = 225; 250 is within 15 percent of 250 (37.5)
    expect(codes({ basis: "per_100g", energy: { value: 255, unit: "kcal" }, protein_g: 5, carbs_g: 40, fat_g: 5 })).toEqual([]);
  });
  it("fibre is counted at 2 kcal per g, like the library", () => {
    expect(codes({ basis: "per_100g", energy: { value: 150, unit: "kcal" }, protein_g: 5, carbs_g: 40, fat_g: 0, fibre_g: 20 })).toEqual([]);
  });
  it("looks like kJ, not kcal", () => {
    const r = validateLabel({ basis: "per_serving", servingSize: 55, servingUnit: "g", energy: { value: 795, unit: "kcal" }, protein_g: 4, carbs_g: 40, fat_g: 1 });
    expect(r.warnings.map((w) => w.code)).toEqual(["energy_looks_like_kj"]);
    expect(r.warnings[0]?.message).toMatch(/^Looks like kJ, not kcal/);
  });
  it("kJ entered as kJ is converted and is fine", () => {
    expect(codes({ basis: "per_serving", servingSize: 55, servingUnit: "g", energy: { value: 795, unit: "kJ" }, protein_g: 4, carbs_g: 40, fat_g: 1 })).toEqual([]);
  });
  it("looks like per pack, not per serving", () => {
    const r = validateLabel({ basis: "per_serving", servingSize: 55, servingUnit: "g", energy: { value: 570, unit: "kcal" }, protein_g: 4, carbs_g: 40, fat_g: 1 });
    expect(r.warnings.map((w) => w.code)).toEqual(["energy_looks_like_per_pack"]);
    expect(r.warnings[0]?.message).toMatch(/^Looks like per pack, not per serving.*3 times/);
  });
  it("a ratio near but not at a whole number is only a mismatch", () => {
    expect(codes({ basis: "per_100g", energy: { value: 190 * 2.5, unit: "kcal" }, protein_g: 4, carbs_g: 40, fat_g: 1 })).toEqual(["energy_macro_mismatch"]);
  });
  it("a multiple above 12 is only a mismatch", () => {
    expect(codes({ basis: "per_serving", servingSize: 1000, servingUnit: "g", energy: { value: 190 * 14, unit: "kcal" }, protein_g: 4, carbs_g: 40, fat_g: 1 })).toEqual(["energy_macro_mismatch"]);
  });
  it("tiny macro estimates do not trigger multiples", () => {
    expect(codes({ basis: "per_100g", energy: { value: 20, unit: "kcal" }, protein_g: 0, carbs_g: 1, fat_g: 0 })).toEqual(["energy_macro_mismatch"]);
  });
  it("zero kcal with real macros is a mismatch; zero kcal with none is fine", () => {
    expect(codes({ basis: "per_100g", energy: { value: 0, unit: "kcal" }, protein_g: 5, carbs_g: 10, fat_g: 2 })).toEqual(["energy_macro_mismatch"]);
    expect(codes({ basis: "per_100g", energy: { value: 0, unit: "kcal" }, protein_g: 0, carbs_g: 0, fat_g: 0 })).toEqual([]);
  });
  it("energy check needs all three macros", () => {
    expect(codes({ basis: "per_100g", energy: { value: 900, unit: "kcal" }, protein_g: 1, carbs_g: 1 })).toEqual([]);
  });
  it("sodium unit sanity", () => {
    expect(codes({ ...pancake, sodium: 6000, sodiumUnit: "mg" })).toEqual(["sodium_unit"]);
    expect(codes({ ...pancake, sodium: 380, sodiumUnit: "g" })).toEqual(["sodium_unit"]);
    expect(validateLabel({ ...pancake, sodium: 380, sodiumUnit: "g" }).warnings[0]?.message).toMatch(/^Check mg against g/);
    expect(codes({ ...pancake, sodium: 0.4, sodiumUnit: "g" })).toEqual([]);
    expect(codes({ ...pancake, sodium: 5000, sodiumUnit: "mg" })).toEqual([]);
    expect(codes({ ...pancake, sodium: 9000, sodiumUnit: undefined })).toEqual([]);
  });
  it("fibre greater than carbs", () => {
    expect(codes({ basis: "per_100g", carbs_g: 5, fibre_g: 8 })).toEqual(["fibre_exceeds_carbs"]);
    expect(codes({ basis: "per_100g", carbs_g: 8, fibre_g: 8 })).toEqual([]);
    expect(codes({ basis: "per_100g", fibre_g: 8 })).toEqual([]);
  });
  it("kcal per 100 g implausible for the aisle", () => {
    const r = validateLabel({ basis: "per_100g", aisle: "vegetables", energy: { value: 400, unit: "kcal" } });
    expect(r.warnings.map((w) => w.code)).toEqual(["kcal_implausible_for_aisle"]);
    expect(codes({ basis: "per_100g", aisle: "oils", energy: { value: 120, unit: "kcal" } })).toEqual(["kcal_implausible_for_aisle"]);
    expect(codes({ basis: "per_100g", aisle: "oils", energy: { value: 884, unit: "kcal" } })).toEqual([]);
    expect(codes({ basis: "per_100g", aisle: "unknown-aisle", energy: { value: 884, unit: "kcal" } })).toEqual([]);
  });
  it("aisle check uses per 100 g after converting from a serving", () => {
    expect(codes({ basis: "per_serving", servingSize: 100, servingUnit: "g", aisle: "fruit", energy: { value: 60, unit: "kcal" } })).toEqual([]);
    expect(codes({ basis: "per_serving", servingSize: 10, servingUnit: "g", aisle: "fruit", energy: { value: 60, unit: "kcal" } })).toContain("kcal_implausible_for_aisle");
  });
});

describe("canSave", () => {
  it("errors always block", () => {
    const r = validateLabel({ basis: "per_100g", protein_g: -1 });
    expect(canSave(r, true)).toBe(false);
  });
  it("warnings need the label confirmation", () => {
    const r = validateLabel({ basis: "per_100g", carbs_g: 5, fibre_g: 8 });
    expect(canSave(r, false)).toBe(false);
    expect(canSave(r, true)).toBe(true);
  });
});
