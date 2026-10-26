/**
 * Unit handling for packaged-food labels. Pure.
 *
 * Grams are the only stored unit. A label arrives per serving, per 100 g or per 100 ml; it is converted to per
 * 100 g once, on entry. A value the label does not report stays `undefined`: it is never turned into 0.
 */

export type UnitName = "g" | "mg" | "µg" | "kcal" | "kJ" | "ml";
export type NutrientAmounts = Readonly<Record<string, number | undefined>>;

export const KJ_PER_KCAL = 4.184;

const UNIT_ALIASES: Readonly<Record<string, UnitName>> = {
  g: "g",
  gr: "g",
  gram: "g",
  grams: "g",
  mg: "mg",
  milligram: "mg",
  milligrams: "mg",
  "µg": "µg",
  "μg": "µg", // Greek mu
  mcg: "µg",
  ug: "µg",
  microgram: "µg",
  micrograms: "µg",
  kcal: "kcal",
  cal: "kcal",
  calories: "kcal",
  kj: "kJ",
  kilojoule: "kJ",
  kilojoules: "kJ",
  ml: "ml",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
};

/** Canonical unit name, or undefined when the text is not a unit this module understands. */
export function normalizeUnit(raw: string): UnitName | undefined {
  return UNIT_ALIASES[raw.trim().toLowerCase().replace(/\.$/, "")];
}

const GRAMS_PER_UNIT: Readonly<Partial<Record<UnitName, number>>> = { g: 1, mg: 0.001, "µg": 0.000001 };

export function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}

export function kcalToKj(kcal: number): number {
  return kcal * KJ_PER_KCAL;
}

/** Convert between units of one family (mass or energy). Undefined for a mixed family or a non-finite value. */
export function convertAmount(value: number, from: UnitName, to: UnitName): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (from === to) return value;
  if (from === "kJ" && to === "kcal") return kjToKcal(value);
  if (from === "kcal" && to === "kJ") return kcalToKj(value);
  const f = GRAMS_PER_UNIT[from];
  const t = GRAMS_PER_UNIT[to];
  if (f === undefined || t === undefined) return undefined;
  return (value * f) / t;
}

export function roundTo(value: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

/** `value / serving * 100`. Refuses (undefined) when the value or a positive serving size is missing. */
export function per100FromServing(value: number | undefined, servingSize: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (servingSize === undefined || !Number.isFinite(servingSize) || servingSize <= 0) return undefined;
  return (value / servingSize) * 100;
}

/** Scale every reported amount by `factor`. Missing amounts stay missing. */
export function scaleAmounts(values: NutrientAmounts, factor: number): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === undefined ? undefined : v * factor;
  return out;
}

export type DensitySource = "pack" | "serving" | "assumed_water";

export interface Density {
  gPerMl: number;
  /** True when the density is a guess (1 g per ml). Anything derived from it is an estimate. */
  estimated: boolean;
  source: DensitySource;
}

export type DensityInput =
  | { packNetG: number; packVolumeMl: number }
  | { servingG: number; servingMl: number }
  | { treatOneMlAsOneG: true };

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Density from the pack (net weight and volume), a weighed serving, or an explicit, flagged 1 ml = 1 g estimate. */
export function resolveDensity(input: DensityInput): Density | undefined {
  if ("packNetG" in input) {
    if (!positive(input.packNetG) || !positive(input.packVolumeMl)) return undefined;
    return { gPerMl: input.packNetG / input.packVolumeMl, estimated: false, source: "pack" };
  }
  if ("servingG" in input) {
    if (!positive(input.servingG) || !positive(input.servingMl)) return undefined;
    return { gPerMl: input.servingG / input.servingMl, estimated: false, source: "serving" };
  }
  return { gPerMl: 1, estimated: true, source: "assumed_water" };
}

/** A per-100 ml value expressed per 100 g. */
export function per100mlToPer100g(valuePer100ml: number | undefined, density: Density | undefined): number | undefined {
  if (valuePer100ml === undefined || !Number.isFinite(valuePer100ml) || !density) return undefined;
  return valuePer100ml / density.gPerMl;
}

export type LabelBasis = "per_100g" | "per_serving" | "per_100ml";

export interface LabelBasisInput {
  basis: LabelBasis;
  /** Serving size for `per_serving`, in `servingUnit`. */
  servingSize?: number;
  servingUnit?: "g" | "ml";
  density?: Density;
}

export type Per100gResult =
  | { ok: true; per100g: Record<string, number | undefined>; estimated: boolean }
  | { ok: false; reason: string };

/** Convert label values to per 100 g, whatever basis the label used. */
export function labelToPer100g(values: NutrientAmounts, input: LabelBasisInput): Per100gResult {
  if (input.basis === "per_100g") return { ok: true, per100g: { ...values }, estimated: false };

  let per100Unit: number; // factor from the label basis to "per 100 of the label's own unit"
  let unit: "g" | "ml";
  if (input.basis === "per_100ml") {
    per100Unit = 1;
    unit = "ml";
  } else {
    const size = input.servingSize;
    if (size === undefined || !positive(size)) return { ok: false, reason: "Serving size is missing, so the label cannot be converted to per 100 g." };
    per100Unit = 100 / size;
    unit = input.servingUnit ?? "g";
  }
  if (unit === "g") return { ok: true, per100g: scaleAmounts(values, per100Unit), estimated: false };

  if (!input.density) return { ok: false, reason: "A density is needed to convert millilitres to grams." };
  return { ok: true, per100g: scaleAmounts(values, per100Unit / input.density.gPerMl), estimated: input.density.estimated };
}

export type LoggedUnit = "g" | "serving" | "piece" | "ml";

export interface LoggedAmount {
  qty: number;
  unit: LoggedUnit;
}

export interface FoodPortions {
  servingG?: number;
  /** Grams in one countable piece (one biscuit, one slice). */
  pieceG?: number;
  densityGPerMl?: number;
  densityEstimated?: boolean;
}

export type GramsResult = { ok: true; grams: number; estimated: boolean } | { ok: false; reason: string };

/** What was eaten, in the friendly unit it was entered in, as grams. The friendly qty and unit stay with the entry for display. */
export function loggedAmountToGrams(amount: LoggedAmount, food: FoodPortions): GramsResult {
  if (!positive(amount.qty)) return { ok: false, reason: "Amount must be more than zero." };
  switch (amount.unit) {
    case "g":
      return { ok: true, grams: amount.qty, estimated: false };
    case "serving":
      if (food.servingG === undefined || !positive(food.servingG)) return { ok: false, reason: "This food has no serving size in grams." };
      return { ok: true, grams: amount.qty * food.servingG, estimated: false };
    case "piece":
      if (food.pieceG === undefined || !positive(food.pieceG)) return { ok: false, reason: "This food has no weight per piece." };
      return { ok: true, grams: amount.qty * food.pieceG, estimated: false };
    case "ml":
      if (food.densityGPerMl === undefined || !positive(food.densityGPerMl)) return { ok: false, reason: "This food has no density, so millilitres cannot be converted." };
      return { ok: true, grams: amount.qty * food.densityGPerMl, estimated: food.densityEstimated === true };
  }
}
