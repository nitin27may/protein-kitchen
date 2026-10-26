import { describe, expect, it } from "vitest";
import {
  buildFoodRecord, canSaveDraft, draftFromStored, draftFromValues, emptyFormValues, evaluateDraft, isEstimatedWeight, labelValuesOf, needsDensity,
  parseTyped, sourceBadge, valuesFromDraft, type FoodFormValues,
} from "../lib/foods/form";
import { filterFoods, foodCatalog } from "../lib/foods/list";
import { FoodDraftInput, FoodSaveInput } from "../lib/schemas/food-draft";

const NOW = new Date("2026-11-02T12:00:00.000Z");

/** Kirkland pancake mix as printed: per 1/3 cup (55 g). */
const pancakeValues = (over: Partial<FoodFormValues> = {}): FoodFormValues => ({
  ...emptyFormValues(), name: "Kirkland pancake batter", brand: "Kirkland Signature", barcode: "", basis: "per_serving", servingSize: "55", servingLabel: "1/3 cup",
  energy: "190", protein: "5", carbs: "40", fat: "1.5", fibre: "1", sugars: "6", sodium: "480", ...over,
});
/** A wet batter: low enough that kJ typed as kcal stays under the 950 kcal limit, so it is a warning, not an error. */
const BATTER = { energy: "90", protein: "2.5", carbs: "17", fat: "1", fibre: "0.5", sugars: "3", sodium: "230" };
const draftOf = (over: Partial<FoodFormValues> = {}) => draftFromValues(pancakeValues(over)).draft;

describe("parseTyped", () => {
  it("reads blanks, decimals and a decimal comma; text is NaN", () => {
    expect(parseTyped("")).toBeUndefined();
    expect(parseTyped("  ")).toBeUndefined();
    expect(parseTyped("5")).toBe(5);
    expect(parseTyped("1.5")).toBe(1.5);
    expect(parseTyped("1,5")).toBe(1.5);
    expect(parseTyped(".5")).toBe(0.5);
    expect(parseTyped("5.")).toBe(5);
    expect(parseTyped("-2")).toBe(-2);
    expect(Number.isNaN(parseTyped("abc"))).toBe(true);
    expect(Number.isNaN(parseTyped("1e3"))).toBe(true);
  });
});

describe("draftFromValues", () => {
  it("drops blanks, trims text and normalises the barcode", () => {
    const { draft, parseErrors } = draftFromValues(pancakeValues({ brand: " ", barcode: "0 6414-4", pieceLabel: "  pancake ", ingredientsText: " flour " }));
    expect(parseErrors).toEqual({});
    expect(draft.brand).toBeUndefined();
    expect(draft.barcode).toBe("06414" + "4");
    expect(draft.pieceLabel).toBe("pancake");
    expect(draft.ingredientsText).toBe("flour");
    expect(draft.sat_fat_g).toBeUndefined();
    expect(draft.fibre_g).toBe(1);
  });

  it("reports text that is not a number and leaves the field out", () => {
    const { draft, parseErrors } = draftFromValues(pancakeValues({ protein: "five", energy: "x", servingSize: "y", micros: { calcium_mg: "z", iron_mg: "2" }, pieceG: "q" }));
    expect(Object.keys(parseErrors).sort()).toEqual(["calcium_mg", "energy", "pieceG", "protein_g", "servingSize"]);
    expect(draft.protein_g).toBeUndefined();
    expect(draft.micros).toEqual({ iron_mg: 2 });
  });

  it("builds the three density choices", () => {
    expect(draftOf({ densityKind: "pack", packNetG: "1030", packVolumeMl: "1000" }).density).toEqual({ kind: "pack", packNetG: 1030, packVolumeMl: 1000 });
    expect(draftOf({ densityKind: "pack", packNetG: "x", packVolumeMl: "" }).density).toEqual({ kind: "pack", packNetG: 0, packVolumeMl: 0 });
    expect(draftOf({ densityKind: "serving", servingWeighG: "255", servingVolumeMl: "250" }).density).toEqual({ kind: "serving", servingG: 255, servingMl: 250 });
    expect(draftOf({ densityKind: "serving", servingWeighG: "", servingVolumeMl: "", servingUnit: "ml", servingSize: "250" }).density).toEqual({ kind: "serving", servingG: 0, servingMl: 250 });
    expect(draftOf({ densityKind: "serving", servingWeighG: "", servingVolumeMl: "", servingUnit: "g" }).density).toEqual({ kind: "serving", servingG: 0, servingMl: 0 });
    expect(draftOf({ densityKind: "assumed" }).density).toEqual({ kind: "assumed" });
    expect(draftOf({ densityKind: "none" }).density).toBeUndefined();
  });

  it("round-trips through valuesFromDraft", () => {
    for (const over of [{}, { densityKind: "pack" as const, packNetG: "1030", packVolumeMl: "1000", servingUnit: "ml" as const, micros: { calcium_mg: "120" } },
      { densityKind: "serving" as const, servingWeighG: "255", servingVolumeMl: "250" }, { densityKind: "assumed" as const, energyUnit: "kJ" as const, sodiumUnit: "g" as const }]) {
      const values = pancakeValues(over);
      expect(valuesFromDraft(draftFromValues(values).draft)).toEqual({ ...values, brand: values.brand, pieceG: "", pieceLabel: "" });
    }
    const bare = valuesFromDraft({ name: "x", basis: "per_100g", servingUnit: "g", state: "dry", sodiumUnit: "mg", isDairy: false, containsOnionGarlic: false, dietChecked: false });
    expect(bare.energy).toBe("");
    expect(bare.energyUnit).toBe("kcal");
    expect(bare.densityKind).toBe("none");
  });
});

describe("evaluateDraft: the Costco pancake mix", () => {
  it("converts a per-serving label (1/3 cup = 55 g) to per 100 g", () => {
    const e = evaluateDraft(draftOf());
    expect(e.fieldErrors).toEqual({});
    expect(e.per100g).toEqual({ kcal: 345.5, protein_g: 9.09, carbs_g: 72.73, fat_g: 2.73, fibre_g: 1.82 });
    expect(e.micros).toEqual({ sugars_g: 10.909, sodium_mg: 872.727 });
    expect(e.servingG).toBe(55);
    expect(e.estimated).toBe(false);
    expect(e.validation.warnings).toEqual([]);
    expect(canSaveDraft(e, false)).toBe(true);
  });

  it("keeps a fibre the label does not report as null, never zero", () => {
    expect(evaluateDraft(draftOf({ fibre: "" })).per100g?.fibre_g).toBeNull();
  });

  it("a label per 100 g needs no conversion", () => {
    const e = evaluateDraft(draftOf({ basis: "per_100g", servingSize: "", energy: "345", protein: "9", carbs: "72", fat: "2.5" }));
    expect(e.per100g).toMatchObject({ kcal: 345, protein_g: 9, carbs_g: 72, fat_g: 2.5 });
    expect(e.servingG).toBeUndefined();
  });

  it("energy typed in kJ is converted", () => {
    const e = evaluateDraft(draftOf({ energy: "795", energyUnit: "kJ" }));
    expect(e.per100g?.kcal).toBe(345.5);
    expect(e.validation.warnings).toEqual([]);
  });

  it("kJ typed into the kcal field is a warning that needs the confirmation", () => {
    const e = evaluateDraft(draftOf({ ...BATTER, energy: "377" }));
    expect(e.validation.warnings.map((w) => w.code)).toEqual(["energy_looks_like_kj"]);
    expect(e.fieldErrors).toEqual({});
    expect(e.per100g?.kcal).toBe(685.5);
    expect(canSaveDraft(e, false)).toBe(false);
    expect(canSaveDraft(e, true)).toBe(true);
  });

  it("kJ typed into the kcal field of a dense food is an error, because it is over 950 kcal per 100 g", () => {
    const e = evaluateDraft(draftOf({ energy: "795" }));
    expect(e.fieldErrors.energy).toMatch(/950/);
    expect(e.per100g).toBeUndefined();
    expect(canSaveDraft(e, true)).toBe(false);
  });

  it("sodium in g is converted to mg", () => {
    expect(evaluateDraft(draftOf({ sodium: "0.48", sodiumUnit: "g" })).micros.sodium_mg).toBe(872.727);
    expect(evaluateDraft(draftOf({ sodium: "380", sodiumUnit: "g" })).validation.warnings.map((w) => w.code)).toContain("sodium_unit");
  });

  it("other nutrients are converted with the same factor", () => {
    expect(evaluateDraft(draftOf({ micros: { calcium_mg: "55" } })).micros.calcium_mg).toBe(100);
    expect(evaluateDraft(draftOf({ satFat: "0.5" })).micros.sat_fat_g).toBe(0.909);
  });
});

describe("evaluateDraft: hard errors", () => {
  it("requires a name, energy and the three macros", () => {
    const e = evaluateDraft(draftFromValues({ ...emptyFormValues(), servingSize: "55" }).draft);
    expect(Object.keys(e.fieldErrors).sort()).toEqual(["carbs_g", "energy", "fat_g", "name", "protein_g"]);
    expect(e.per100g).toBeUndefined();
    expect(canSaveDraft(e, true)).toBe(false);
  });

  it("refuses a barcode with a bad check digit and accepts a good one", () => {
    expect(evaluateDraft(draftOf({ barcode: "12345678" })).fieldErrors.barcode).toMatch(/check digit/);
    expect(evaluateDraft(draftOf({ barcode: "96385074" })).fieldErrors.barcode).toBeUndefined();
  });

  it("refuses a missing serving size on a per-serving label", () => {
    const e = evaluateDraft(draftOf({ servingSize: "" }));
    expect(e.fieldErrors.servingSize).toMatch(/serving size/i);
    expect(e.per100g).toBeUndefined();
  });

  it("refuses a serving size that cannot convert (zero)", () => {
    const e = evaluateDraft(draftOf({ servingSize: "0" }));
    expect(e.fieldErrors.servingSize).toBeDefined();
  });

  it("refuses protein above the serving, macros above 100 g, and negative values", () => {
    expect(evaluateDraft(draftOf({ protein: "60" })).fieldErrors.protein_g).toBeDefined();
    expect(evaluateDraft(draftOf({ protein: "30", carbs: "30", fat: "30", energy: "500", servingSize: "30" })).per100g).toBeUndefined();
    expect(evaluateDraft(draftOf({ fat: "-1" })).fieldErrors.fat_g).toMatch(/negative/);
    expect(evaluateDraft(draftOf({ micros: { calcium_mg: "-3" } })).fieldErrors.calcium_mg).toMatch(/negative/);
    expect(evaluateDraft(draftOf({ satFat: "-3" })).fieldErrors.sat_fat_g).toMatch(/negative/);
  });

  it("refuses a piece with no weight", () => {
    expect(evaluateDraft(draftOf({ pieceG: "0" })).fieldErrors.pieceG).toBeDefined();
  });
});

describe("evaluateDraft: liquids", () => {
  const drink = (over: Partial<FoodFormValues> = {}) => pancakeValues({ name: "Oat drink", basis: "per_100ml", servingSize: "", energy: "46", protein: "1", carbs: "6.7", fat: "1.5", fibre: "", sugars: "", sodium: "", ...over });
  const evalDrink = (over: Partial<FoodFormValues> = {}) => evaluateDraft(draftFromValues(drink(over)).draft);

  it("needs a density for ml", () => {
    expect(needsDensity({ basis: "per_100ml", servingUnit: "g" })).toBe(true);
    expect(needsDensity({ basis: "per_serving", servingUnit: "ml" })).toBe(true);
    expect(needsDensity({ basis: "per_serving", servingUnit: "g" })).toBe(false);
    expect(needsDensity({ basis: "per_100g", servingUnit: "ml" })).toBe(false);
    const e = evalDrink();
    expect(e.fieldErrors.density).toMatch(/Millilitres need a weight/);
    expect(e.per100g).toBeUndefined();
  });

  it("converts with the pack weight and volume", () => {
    const e = evalDrink({ densityKind: "pack", packNetG: "1030", packVolumeMl: "1000" });
    expect(e.fieldErrors).toEqual({});
    expect(e.density?.gPerMl).toBeCloseTo(1.03);
    expect(e.per100g?.kcal).toBe(44.7);
    expect(e.estimated).toBe(false);
  });

  it("flags every figure as estimated when 1 ml is treated as 1 g", () => {
    const e = evalDrink({ densityKind: "assumed" });
    expect(e.per100g?.kcal).toBe(46);
    expect(e.estimated).toBe(true);
    const record = buildFoodRecord(draftFromValues(drink({ densityKind: "assumed" })).draft, { hasLabelPhoto: false, checkedAgainstLabel: false, now: NOW });
    expect(record.ok && record.estimated).toBe(true);
    if (record.ok) {
      expect(record.input.densityGPerMl).toBe(1);
      expect(record.input.fieldOrigins).toMatchObject({ densityGPerMl: "assumed_water" });
      expect(record.input.labelValues).toMatchObject({ density_estimated: true });
      expect(isEstimatedWeight(record.input.fieldOrigins ?? {})).toBe(true);
    }
  });

  it("refuses an incomplete density", () => {
    const e = evalDrink({ densityKind: "pack", packNetG: "1030", packVolumeMl: "" });
    expect(e.fieldErrors.density).toMatch(/both the weight and the volume/);
  });

  it("derives the serving in grams for a serving in ml, and in ml for a serving in g", () => {
    const ml = evaluateDraft(draftFromValues(pancakeValues({ servingUnit: "ml", servingSize: "250", densityKind: "serving", servingWeighG: "255", energy: "115", protein: "2.5", carbs: "16.7", fat: "3.7" })).draft);
    expect(ml.fieldErrors).toEqual({});
    expect(ml.servingMl).toBe(250);
    expect(ml.servingG).toBe(255);
    const g = evaluateDraft(draftFromValues(pancakeValues({ basis: "per_100g", servingUnit: "g", servingSize: "30", densityKind: "pack", packNetG: "1030", packVolumeMl: "1000", energy: "345", protein: "9", carbs: "72", fat: "2.5" })).draft);
    expect(g.servingG).toBe(30);
    expect(g.servingMl).toBe(29.13);
  });

  it("a per-100g label in ml with no density still converts, with no grams per serving", () => {
    const e = evaluateDraft(draftFromValues(pancakeValues({ basis: "per_100g", servingUnit: "ml", servingSize: "30", energy: "345", protein: "9", carbs: "72", fat: "2.5" })).draft);
    expect(e.fieldErrors).toEqual({});
    expect(e.servingMl).toBe(30);
    expect(e.servingG).toBeUndefined();
  });
});

describe("buildFoodRecord", () => {
  it("builds the stored record with provenance and the not-reported list", () => {
    const draft = draftOf({ ingredientsText: "Wheat flour, sugar, buttermilk powder. May contain egg.", isDairy: true, dietChecked: true });
    const r = buildFoodRecord(draft, { hasLabelPhoto: true, checkedAgainstLabel: false, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      name: "Kirkland pancake batter", brand: "Kirkland Signature", barcode: null, state: "ready", aisle: "packaged",
      kcal: 345.5, proteinG: 9.09, carbsG: 72.73, fatG: 2.73, fibreG: 1.82, servingLabel: "1/3 cup", servingG: 55, servingMl: null, densityGPerMl: null,
      pieceLabel: null, pieceG: null, labelBasis: "per_serving", source: "LABEL", sourceId: null, isDairy: true, containsOnionGarlic: false,
      dietFlagsFound: [], dietCheckedAt: "2026-11-02T12:00:00.000Z",
    });
    expect(r.input.per100gMicros).toEqual({ sugars_g: 10.909, sodium_mg: 872.727 });
    expect(r.input.notReported).toContain("calcium_mg");
    expect(r.input.notReported).not.toContain("sodium_mg");
    expect(r.input.fieldOrigins).toEqual({ kcal: "typed", proteinG: "typed", carbsG: "typed", fatG: "typed", fibreG: "typed", sugars_g: "typed", sodium_mg: "typed" });
    expect(r.input.labelValues).toMatchObject({ basis: "per_serving", serving_size: 55, energy: { value: 190, unit: "kcal" }, protein_g: 5, sodium: 480, sodium_unit: "mg" });
  });

  it("is MANUAL without a label photo; a piece without a label is called piece; diet flags are recorded", () => {
    const r = buildFoodRecord(draftOf({ pieceG: "30", ingredientsText: "Flour, egg powder, gelatin", fibre: "" }), { hasLabelPhoto: false, checkedAgainstLabel: false, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({ source: "MANUAL", pieceLabel: "piece", pieceG: 30, dietCheckedAt: null, fibreG: null });
    expect(r.input.dietFlagsFound).toEqual(["egg", "gelatin"]);
    expect(r.input.fieldOrigins).not.toHaveProperty("fibreG");
    const named = buildFoodRecord(draftOf({ pieceG: "30", pieceLabel: "pancake" }), { hasLabelPhoto: false, checkedAgainstLabel: false, now: NOW });
    expect(named.ok && named.input.pieceLabel).toBe("pancake");
  });

  it("refuses hard errors with the first message and every field", () => {
    const r = buildFoodRecord(draftOf({ protein: "" }), { hasLabelPhoto: true, checkedAgainstLabel: true, now: NOW });
    expect(r).toMatchObject({ ok: false, message: "Required. Enter 0 if the label shows 0.", fieldErrors: { protein_g: expect.any(String) } });
  });

  it("refuses an unconvertible label with a plain message even when no field is named", () => {
    const r = buildFoodRecord(draftOf({ servingSize: "" }), { hasLabelPhoto: true, checkedAgainstLabel: true, now: NOW });
    expect(r.ok).toBe(false);
  });

  it("refuses warnings until they are confirmed", () => {
    const draft = draftOf({ ...BATTER, energy: "377" });
    const refused = buildFoodRecord(draft, { hasLabelPhoto: true, checkedAgainstLabel: false, now: NOW });
    expect(refused).toMatchObject({ ok: false, fieldErrors: { energy: expect.stringMatching(/kJ/) } });
    expect(buildFoodRecord(draft, { hasLabelPhoto: true, checkedAgainstLabel: true, now: NOW }).ok).toBe(true);
  });
});

describe("draftFromStored", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    name: "Kirkland pancake batter", brand: "Kirkland Signature" as string | null, barcode: null as string | null, state: "ready" as const, labelBasis: "per_serving" as const,
    labelValues: {} as Record<string, unknown>, servingLabel: "1/3 cup" as string | null, pieceLabel: null as string | null, pieceG: null as number | null,
    ingredientsText: null as string | null, isDairy: false, containsOnionGarlic: false, dietCheckedAt: null as string | null, kcal: 345.5, proteinG: 9.09, carbsG: 72.73,
    fatG: 2.73, fibreG: 1.82 as number | null, ...over,
  });

  it("restores the printed numbers a food was saved with", () => {
    const draft = draftOf({ energy: "795", energyUnit: "kJ", sodium: "0.48", sodiumUnit: "g", micros: { calcium_mg: "40" }, densityKind: "pack", packNetG: "1030", packVolumeMl: "1000", servingUnit: "ml" });
    const back = draftFromStored(stored({ labelValues: labelValuesOf(draft), pieceLabel: "pancake", pieceG: 30, barcode: "96385074", ingredientsText: "flour", dietCheckedAt: "2026-11-02T00:00:00.000Z" }));
    expect(back).toMatchObject({
      basis: "per_serving", servingUnit: "ml", servingSize: 55, energy: { value: 795, unit: "kJ" }, protein_g: 5, carbs_g: 40, fat_g: 1.5, fibre_g: 1, sugar_g: 6,
      sodium: 0.48, sodiumUnit: "g", micros: { calcium_mg: 40 }, density: { kind: "pack", packNetG: 1030, packVolumeMl: 1000 }, pieceG: 30, pieceLabel: "pancake",
      barcode: "96385074", ingredientsText: "flour", dietChecked: true, brand: "Kirkland Signature", servingLabel: "1/3 cup",
    });
  });

  it("restores the serving and assumed density choices, and ignores junk in the stored values", () => {
    for (const density of [{ kind: "serving" as const, servingG: 255, servingMl: 250 }, { kind: "assumed" as const }]) {
      expect(draftFromStored(stored({ labelValues: labelValuesOf({ ...draftOf(), density }) })).density).toEqual(density);
    }
    const junk = draftFromStored(stored({ labelValues: { ...labelValuesOf(draftOf()), micros: { calcium_mg: "x", iron_mg: 2 }, density: { kind: "pack" } } }));
    expect(junk.micros).toEqual({ iron_mg: 2 });
    expect(junk.density).toEqual({ kind: "pack", packNetG: 0, packVolumeMl: 0 });
    const junkServing = draftFromStored(stored({ labelValues: { ...labelValuesOf(draftOf()), density: { kind: "serving" } } }));
    expect(junkServing.density).toEqual({ kind: "serving", servingG: 0, servingMl: 0 });
  });

  it("shows a food without printed values per 100 g, from its stored figures", () => {
    const draft = draftFromStored(stored({ fibreG: null, brand: null, servingLabel: null }));
    expect(draft).toMatchObject({ basis: "per_100g", energy: { value: 345.5, unit: "kcal" }, protein_g: 9.09, carbs_g: 72.73, fat_g: 2.73 });
    expect(draft.fibre_g).toBeUndefined();
    expect(draft.brand).toBeUndefined();
    expect(draft.servingSize).toBeUndefined();
    expect(draft.sugar_g).toBeUndefined();
  });

  it("falls back to the stored energy when the printed energy is unreadable", () => {
    const draft = draftFromStored(stored({ labelValues: { basis: "per_serving", energy: { value: "x" } } }));
    expect(draft.energy).toEqual({ value: 345.5, unit: "kcal" });
  });
});

describe("display helpers", () => {
  it("names the source in plain words", () => {
    expect(sourceBadge("LABEL")).toEqual({ text: "From label, confirmed", tone: "ok" });
    expect(sourceBadge("OFF")).toEqual({ text: "From Open Food Facts, checked", tone: "info" });
    expect(sourceBadge("MANUAL")).toEqual({ text: "Typed by you, no label", tone: "warn" });
  });
  it("only the 1 ml = 1 g guess is an estimated weight", () => {
    expect(isEstimatedWeight({ densityGPerMl: "assumed_water" })).toBe(true);
    expect(isEstimatedWeight({ densityGPerMl: "pack" })).toBe(false);
    expect(isEstimatedWeight({})).toBe(false);
  });
});

describe("food list search", () => {
  const foods = [
    { uid: "u1", name: "Kirkland pancake batter", brand: "Kirkland Signature", barcode: "96385074", archived: false },
    { uid: "u2", name: "Greek yogurt", brand: "Oikos", barcode: null, archived: false },
    { uid: "u3", name: "Old granola", brand: null, barcode: null, archived: true },
  ];
  it("searches by name, brand and barcode, and hides archived foods unless asked", () => {
    expect(filterFoods(foods, "pancake", { includeArchived: false }).map((f) => f.uid)).toEqual(["u1"]);
    expect(filterFoods(foods, "oikos", { includeArchived: false }).map((f) => f.uid)).toEqual(["u2"]);
    expect(filterFoods(foods, "96385074", { includeArchived: false }).map((f) => f.uid)).toEqual(["u1"]);
    expect(filterFoods(foods, "", { includeArchived: false }).map((f) => f.uid)).toEqual(["u2", "u1"]);
    expect(filterFoods(foods, "granola", { includeArchived: false })).toEqual([]);
    expect(filterFoods(foods, "granola", { includeArchived: true }).map((f) => f.uid)).toEqual(["u3"]);
    expect(filterFoods([], "", { includeArchived: false })).toEqual([]);
  });
  it("lists the most used first when there is no query", () => {
    const usage = { "hf:u1": { count: 5 } };
    expect(filterFoods(foods, "", { includeArchived: false, usage }).map((f) => f.uid)).toEqual(["u1", "u2"]);
  });
  it("builds catalog entries keyed hf:<uid>", () => {
    expect(foodCatalog(foods).map((i) => i.key)).toEqual(["hf:u1", "hf:u2", "hf:u3"]);
  });
});

describe("draft schema", () => {
  const ok = () => JSON.parse(JSON.stringify(draftOf()));
  it("accepts a draft and the confirmation", () => {
    expect(FoodDraftInput.safeParse(ok()).success).toBe(true);
    expect(FoodSaveInput.safeParse({ draft: ok(), checkedAgainstLabel: false }).success).toBe(true);
  });
  it("refuses unknown keys, bad shapes and other nutrient keys", () => {
    expect(FoodDraftInput.safeParse({ ...ok(), per100g: { kcal: 1 } }).success).toBe(false);
    expect(FoodDraftInput.safeParse({ ...ok(), basis: "per_pack" }).success).toBe(false);
    expect(FoodDraftInput.safeParse({ ...ok(), barcode: "12ab" }).success).toBe(false);
    expect(FoodDraftInput.safeParse({ ...ok(), micros: { zinc_mg: 1 } }).success).toBe(false);
    expect(FoodDraftInput.safeParse({ ...ok(), name: "x".repeat(121) }).success).toBe(false);
    expect(FoodDraftInput.safeParse({ ...ok(), energy: { value: Number.POSITIVE_INFINITY, unit: "kcal" } }).success).toBe(false);
    expect(FoodSaveInput.safeParse({ draft: ok() }).success).toBe(false);
  });
});
