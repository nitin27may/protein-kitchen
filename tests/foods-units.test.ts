import { describe, expect, it } from "vitest";
import {
  convertAmount,
  kcalToKj,
  kjToKcal,
  labelToPer100g,
  loggedAmountToGrams,
  normalizeUnit,
  per100FromServing,
  per100mlToPer100g,
  resolveDensity,
  roundTo,
  scaleAmounts,
} from "@/lib/foods/units";

describe("normalizeUnit", () => {
  it.each([
    ["g", "g"], [" Grams ", "g"], ["mg", "mg"], ["µg", "µg"], ["μg", "µg"], ["mcg", "µg"], ["UG", "µg"],
    ["kcal", "kcal"], ["Calories", "kcal"], ["kJ", "kJ"], ["kilojoules", "kJ"], ["mL", "ml"], ["ml.", "ml"],
  ])("%s -> %s", (raw, expected) => expect(normalizeUnit(raw)).toBe(expected));
  it("returns undefined for unknown text", () => expect(normalizeUnit("cups")).toBeUndefined());
});

describe("energy and mass conversion", () => {
  it("kJ to kcal divides by 4.184", () => {
    expect(kjToKcal(418.4)).toBeCloseTo(100, 6);
    expect(kcalToKj(100)).toBeCloseTo(418.4, 6);
  });
  it("converts within a family", () => {
    expect(convertAmount(500, "mg", "g")).toBeCloseTo(0.5);
    expect(convertAmount(2, "g", "mg")).toBeCloseTo(2000);
    expect(convertAmount(250, "µg", "mg")).toBeCloseTo(0.25);
    expect(convertAmount(836, "kJ", "kcal")).toBeCloseTo(199.81, 1);
    expect(convertAmount(200, "kcal", "kJ")).toBeCloseTo(836.8, 1);
    expect(convertAmount(5, "g", "g")).toBe(5);
  });
  it("refuses mixed families and non-finite values", () => {
    expect(convertAmount(1, "g", "kcal")).toBeUndefined();
    expect(convertAmount(1, "ml", "g")).toBeUndefined();
    expect(convertAmount(Number.NaN, "g", "mg")).toBeUndefined();
  });
  it("rounds", () => expect(roundTo(7.2727, 1)).toBe(7.3));
});

describe("per100FromServing", () => {
  it("is value / serving * 100", () => {
    expect(per100FromServing(4, 55)).toBeCloseTo(7.2727, 3);
  });
  it("refuses when the serving or value is missing or invalid", () => {
    expect(per100FromServing(4, undefined)).toBeUndefined();
    expect(per100FromServing(4, 0)).toBeUndefined();
    expect(per100FromServing(4, -5)).toBeUndefined();
    expect(per100FromServing(4, Number.NaN)).toBeUndefined();
    expect(per100FromServing(undefined, 55)).toBeUndefined();
    expect(per100FromServing(Number.NaN, 55)).toBeUndefined();
  });
  it("never turns a missing value into zero", () => {
    expect(per100FromServing(undefined, 55)).not.toBe(0);
    expect(per100FromServing(0, 55)).toBe(0);
  });
});

describe("scaleAmounts", () => {
  it("keeps missing values missing", () => {
    const out = scaleAmounts({ kcal: 100, fibre_g: undefined, fat_g: 0 }, 2);
    expect(out).toEqual({ kcal: 200, fibre_g: undefined, fat_g: 0 });
    expect("fibre_g" in out).toBe(true);
  });
});

describe("density", () => {
  it("from pack weight and volume", () => {
    expect(resolveDensity({ packNetG: 1030, packVolumeMl: 1000 })).toEqual({ gPerMl: 1.03, estimated: false, source: "pack" });
  });
  it("from a weighed serving", () => {
    expect(resolveDensity({ servingG: 258, servingMl: 250 })).toEqual({ gPerMl: 1.032, estimated: false, source: "serving" });
  });
  it("explicit 1 ml = 1 g is flagged estimated", () => {
    expect(resolveDensity({ treatOneMlAsOneG: true })).toEqual({ gPerMl: 1, estimated: true, source: "assumed_water" });
  });
  it("rejects non-positive inputs", () => {
    expect(resolveDensity({ packNetG: 0, packVolumeMl: 1000 })).toBeUndefined();
    expect(resolveDensity({ packNetG: 1000, packVolumeMl: -1 })).toBeUndefined();
    expect(resolveDensity({ servingG: 0, servingMl: 250 })).toBeUndefined();
    expect(resolveDensity({ servingG: 250, servingMl: Number.NaN })).toBeUndefined();
  });
  it("converts per 100 ml to per 100 g", () => {
    const d = resolveDensity({ packNetG: 1030, packVolumeMl: 1000 });
    expect(per100mlToPer100g(61.8, d)).toBeCloseTo(60, 6);
    expect(per100mlToPer100g(undefined, d)).toBeUndefined();
    expect(per100mlToPer100g(Number.NaN, d)).toBeUndefined();
    expect(per100mlToPer100g(10, undefined)).toBeUndefined();
  });
});

describe("labelToPer100g", () => {
  it("Costco pancake mix: per 1/3 cup = 55 g label, logged at 110 g", () => {
    const r = labelToPer100g({ kcal: 190, protein_g: 4, carbs_g: 40, fat_g: 1, fibre_g: undefined }, { basis: "per_serving", servingSize: 55, servingUnit: "g" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.estimated).toBe(false);
    expect(r.per100g.kcal).toBeCloseTo(345.45, 1);
    expect(r.per100g.protein_g).toBeCloseTo(7.2727, 3);
    expect(r.per100g.fibre_g).toBeUndefined();
    const g = loggedAmountToGrams({ qty: 2, unit: "serving" }, { servingG: 55 });
    expect(g).toEqual({ ok: true, grams: 110, estimated: false });
    if (!g.ok) return;
    expect((r.per100g.protein_g as number) * (g.grams / 100)).toBeCloseTo(8, 6);
    expect((r.per100g.kcal as number) * (g.grams / 100)).toBeCloseTo(380, 6);
  });
  it("per_100g passes through", () => {
    expect(labelToPer100g({ kcal: 50 }, { basis: "per_100g" })).toEqual({ ok: true, per100g: { kcal: 50 }, estimated: false });
  });
  it("per serving refuses without a serving size", () => {
    const r = labelToPer100g({ kcal: 50 }, { basis: "per_serving" });
    expect(r.ok).toBe(false);
    expect(labelToPer100g({ kcal: 50 }, { basis: "per_serving", servingSize: 0 }).ok).toBe(false);
  });
  it("per serving defaults to grams when the unit is omitted", () => {
    const r = labelToPer100g({ kcal: 50 }, { basis: "per_serving", servingSize: 25 });
    expect(r).toEqual({ ok: true, per100g: { kcal: 200 }, estimated: false });
  });
  it("per 100 ml with a pack density", () => {
    const density = resolveDensity({ packNetG: 1030, packVolumeMl: 1000 });
    const r = labelToPer100g({ kcal: 61.8 }, { basis: "per_100ml", density });
    expect(r.ok && r.per100g.kcal).toBeCloseTo(60, 6);
    expect(r.ok && r.estimated).toBe(false);
  });
  it("per 100 ml with the 1 ml = 1 g estimate is flagged estimated", () => {
    const r = labelToPer100g({ kcal: 42 }, { basis: "per_100ml", density: resolveDensity({ treatOneMlAsOneG: true }) });
    expect(r).toEqual({ ok: true, per100g: { kcal: 42 }, estimated: true });
  });
  it("per 100 ml without a density is refused", () => {
    expect(labelToPer100g({ kcal: 42 }, { basis: "per_100ml" }).ok).toBe(false);
  });
  it("per serving in ml uses the density", () => {
    const r = labelToPer100g({ kcal: 100 }, { basis: "per_serving", servingSize: 250, servingUnit: "ml", density: { gPerMl: 1.25, estimated: false, source: "pack" } });
    expect(r.ok && r.per100g.kcal).toBeCloseTo(32, 6);
    expect(labelToPer100g({ kcal: 100 }, { basis: "per_serving", servingSize: 250, servingUnit: "ml" }).ok).toBe(false);
  });
});

describe("loggedAmountToGrams", () => {
  const food = { servingG: 30, pieceG: 12, densityGPerMl: 1.03 };
  it("grams stay grams", () => expect(loggedAmountToGrams({ qty: 85, unit: "g" }, {})).toEqual({ ok: true, grams: 85, estimated: false }));
  it("servings", () => expect(loggedAmountToGrams({ qty: 1.5, unit: "serving" }, food)).toEqual({ ok: true, grams: 45, estimated: false }));
  it("pieces", () => expect(loggedAmountToGrams({ qty: 3, unit: "piece" }, food)).toEqual({ ok: true, grams: 36, estimated: false }));
  it("ml with a real density", () => {
    const r = loggedAmountToGrams({ qty: 200, unit: "ml" }, food);
    expect(r.ok && r.grams).toBeCloseTo(206);
    expect(r.ok && r.estimated).toBe(false);
  });
  it("ml with an estimated density is flagged", () => {
    expect(loggedAmountToGrams({ qty: 200, unit: "ml" }, { densityGPerMl: 1, densityEstimated: true })).toEqual({ ok: true, grams: 200, estimated: true });
  });
  it("refuses when the food lacks the conversion", () => {
    expect(loggedAmountToGrams({ qty: 1, unit: "serving" }, {}).ok).toBe(false);
    expect(loggedAmountToGrams({ qty: 1, unit: "piece" }, {}).ok).toBe(false);
    expect(loggedAmountToGrams({ qty: 1, unit: "ml" }, {}).ok).toBe(false);
  });
  it("refuses zero, negative or non-finite amounts", () => {
    expect(loggedAmountToGrams({ qty: 0, unit: "g" }, food).ok).toBe(false);
    expect(loggedAmountToGrams({ qty: -1, unit: "g" }, food).ok).toBe(false);
    expect(loggedAmountToGrams({ qty: Number.NaN, unit: "g" }, food).ok).toBe(false);
  });
});
