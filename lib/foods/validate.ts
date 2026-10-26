/**
 * Plausibility checks for a nutrition label typed in by a person (or, later, read from a photo). Pure.
 *
 * Errors block saving. Warnings need an explicit "I checked this against the label" from the person.
 * A field the label does not report is `undefined` and is skipped, never treated as 0.
 */
import { atwaterKcal, kcalDeviationOk } from "../nutrition/macros";
import { convertAmount, type LabelBasis } from "./units";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  field: string;
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface LabelInput {
  /** What the numbers below are "per". */
  basis: LabelBasis;
  /** Serving size in `servingUnit`. Needed for `per_serving`; checked whenever present. */
  servingSize?: number;
  servingUnit?: "g" | "ml";
  /** Library aisle, used for a plausible-energy check. */
  aisle?: string;
  energy?: { value: number; unit: "kcal" | "kJ" };
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  fibre_g?: number;
  sugar_g?: number;
  sodium?: number;
  sodiumUnit?: "mg" | "g";
}

export interface LabelValidation {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Any error: the food cannot be saved. */
  blocked: boolean;
  /** Warnings present: saving needs the "I checked this against the label" confirmation. */
  needsConfirmation: boolean;
}

/** Plausible kcal per 100 g by aisle. Outside the range is a warning, not an error. */
export const AISLE_KCAL_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  vegetables: [0, 200],
  fruit: [0, 200],
  legumes: [20, 400],
  grains: [30, 450],
  flours: [250, 450],
  dairy: [0, 750],
  fats: [600, 950],
  oils: [800, 950],
  "nuts-seeds": [400, 750],
  "dried-fruit": [200, 400],
  spices: [0, 500],
  beverages: [0, 150],
};

const MACRO_NAMES = [
  ["protein_g", "Protein"],
  ["carbs_g", "Carbohydrate"],
  ["fat_g", "Fat"],
] as const;

const NUMERIC_FIELDS = ["protein_g", "carbs_g", "fat_g", "fibre_g", "sugar_g", "sodium"] as const;

function issue(field: string, severity: IssueSeverity, code: string, message: string): ValidationIssue {
  return { field, severity, code, message };
}

function isNum(n: number | undefined): n is number {
  return n !== undefined;
}

function wholeMultiple(ratio: number): number | undefined {
  const r = Math.round(ratio);
  if (r < 2 || r > 12) return undefined;
  return Math.abs(ratio - r) <= 0.1 * r ? r : undefined;
}

export function validateLabel(input: LabelInput): LabelValidation {
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  // Negative and non-finite numbers.
  const numeric: Array<[string, number | undefined]> = [
    ["servingSize", input.servingSize],
    ["energy", input.energy?.value],
    ...NUMERIC_FIELDS.map((f) => [f, input[f]] as [string, number | undefined]),
  ];
  const badNumber = new Set<string>();
  for (const [field, v] of numeric) {
    if (v === undefined) continue;
    if (!Number.isFinite(v)) {
      badNumber.add(field);
      push(issue(field, "error", "invalid_number", "Enter a number."));
    } else if (v < 0) {
      badNumber.add(field);
      push(issue(field, "error", "negative_value", "Values cannot be negative."));
    }
  }

  // Serving size.
  const size = input.servingSize;
  const sizeOk = isNum(size) && !badNumber.has("servingSize");
  if (sizeOk && (size < 1 || size > 1000)) {
    push(issue("servingSize", "error", "serving_size_range", `Serving size must be between 1 and 1000 ${input.servingUnit ?? "g"}.`));
  }
  if (input.basis === "per_serving" && size === undefined) {
    push(issue("servingSize", "error", "serving_size_missing", "Per-serving values need the serving size in grams or millilitres."));
  }

  // Normalise to "per 100 of the basis unit" for the hard limits.
  let factor: number | undefined = 1;
  if (input.basis === "per_serving") factor = sizeOk && size > 0 ? 100 / size : undefined;
  const per100 = (v: number | undefined): number | undefined => (v === undefined || factor === undefined ? undefined : v * factor);

  const kcal = input.energy && !badNumber.has("energy") ? convertAmount(input.energy.value, input.energy.unit, "kcal") : undefined;
  const macros = { protein_g: input.protein_g, carbs_g: input.carbs_g, fat_g: input.fat_g };

  let macroSum = 0;
  let macroCount = 0;
  for (const [field, name] of MACRO_NAMES) {
    const p = badNumber.has(field) ? undefined : per100(macros[field]);
    if (p === undefined) continue;
    macroSum += p;
    macroCount += 1;
    if (p > 100) {
      push(issue(field, "error", "macro_over_100", `${name} cannot be more than 100 g per 100 g.`));
    }
  }
  if (macroCount > 0 && macroSum > 105) {
    push(issue("macros", "error", "macro_sum_over_105", "Protein, carbohydrate and fat add up to more than 105 g per 100 g."));
  }
  const kcal100 = per100(kcal);
  if (kcal100 !== undefined && kcal100 > 950) {
    push(issue("energy", "error", "kcal_over_950", "More than 950 kcal per 100 g is not possible. Check the energy and serving size."));
  }
  if (input.basis === "per_serving" && isNum(input.protein_g) && sizeOk && input.protein_g > size) {
    push(issue("protein_g", "error", "protein_exceeds_serving", "Protein per serving cannot be more than the serving itself."));
  }

  // Warnings: energy against macros.
  const { protein_g: p, carbs_g: c, fat_g: f } = macros;
  if (kcal !== undefined && isNum(p) && isNum(c) && isNum(f) && !["protein_g", "carbs_g", "fat_g", "fibre_g"].some((k) => badNumber.has(k))) {
    const fibre = input.fibre_g ?? 0;
    const estimate = atwaterKcal({ kcal, protein_g: p, carbs_g: c, fat_g: f, fibre_g: fibre });
    const ratio = estimate >= 10 && kcal > 0 ? kcal / estimate : undefined;
    const multiple = ratio === undefined ? undefined : wholeMultiple(ratio);
    if (ratio !== undefined && ratio >= 3.8 && ratio <= 4.6) {
      push(issue("energy", "warning", "energy_looks_like_kj", "Looks like kJ, not kcal. The energy is about 4.2 times what the macros give."));
    } else if (multiple !== undefined) {
      push(issue("energy", "warning", "energy_looks_like_per_pack", `Looks like per pack, not per serving. The energy is about ${multiple} times what the macros give.`));
    } else if (!kcalDeviationOk({ kcal, protein_g: p, carbs_g: c, fat_g: f, fibre_g: fibre })) {
      push(issue("energy", "warning", "energy_macro_mismatch", `Energy (${Math.round(kcal)} kcal) does not match the macros (about ${Math.round(estimate)} kcal). Sugar alcohols (polyols) can explain a gap.`));
    }
  }

  // Warnings: sodium unit.
  if (isNum(input.sodium) && input.sodiumUnit && !badNumber.has("sodium")) {
    if ((input.sodiumUnit === "g" && input.sodium >= 5) || (input.sodiumUnit === "mg" && input.sodium > 5000)) {
      push(issue("sodium", "warning", "sodium_unit", "Check mg against g. This sodium amount is unusually high for the unit chosen."));
    }
  }

  // Warnings: fibre against carbohydrate.
  if (isNum(input.fibre_g) && isNum(c) && input.fibre_g > c && !badNumber.has("fibre_g") && !badNumber.has("carbs_g")) {
    push(issue("fibre_g", "warning", "fibre_exceeds_carbs", "Fibre is higher than carbohydrate. Confirm the label reports carbohydrate this way."));
  }

  // Warnings: energy for the aisle.
  const range = input.aisle ? AISLE_KCAL_RANGE[input.aisle] : undefined;
  if (range && kcal100 !== undefined && (kcal100 < range[0] || kcal100 > range[1])) {
    push(issue("energy", "warning", "kcal_implausible_for_aisle", `${Math.round(kcal100)} kcal per 100 g is unusual for ${input.aisle} (expected ${range[0]} to ${range[1]}).`));
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { issues, errors, warnings, blocked: errors.length > 0, needsConfirmation: warnings.length > 0 };
}

/** Saving is allowed when there are no errors and, if there are warnings, the person confirmed against the label. */
export function canSave(result: LabelValidation, checkedAgainstLabel: boolean): boolean {
  if (result.blocked) return false;
  return !result.needsConfirmation || checkedAgainstLabel;
}
