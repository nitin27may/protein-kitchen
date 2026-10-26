/**
 * The label form for a household food, as pure logic. The phone uses it for the live preview and the server runs the
 * same functions again before it saves, so what the person saw is what is stored and a tampered request gains nothing.
 * Must not import lib/server, lib/db, lib/auth, lib/human, lib/blob or next/*.
 *
 * Text typed in a field becomes a `FoodDraft` (numbers, or undefined for "not reported"). A draft is evaluated against the
 * label rules in validate.ts and converted to per 100 g with units.ts. Nothing is estimated silently: a density from
 * "treat 1 ml as 1 g" marks every figure derived from it.
 */
import { MICRO_LABELS } from "../nutrition/labels";
import type { HouseholdFoodInputData } from "../schemas/food";
import { isValidGtin, normalizeBarcode } from "./catalog";
import { screenIngredients, type DietScreen } from "./diet-screen";
import { convertAmount, labelToPer100g, resolveDensity, roundTo, type Density, type DensityInput, type LabelBasis } from "./units";
import { canSave, validateLabel, type LabelValidation } from "./validate";

export const FOOD_FORM_STATES = ["ready", "dry", "cooked", "raw"] as const;
export type FoodFormState = (typeof FOOD_FORM_STATES)[number];

/** Optional nutrients the form offers beyond the main panel. Everything not typed is stored as "not reported". */
export const OPTIONAL_MICRO_KEYS = ["calcium_mg", "iron_mg", "potassium_mg", "cholesterol_mg", "vitamin_d_ug", "vitamin_c_mg"] as const;
export const ALL_MICRO_KEYS: readonly string[] = MICRO_LABELS.map((m) => m.key);

export type DensityChoice =
  | { kind: "pack"; packNetG: number; packVolumeMl: number }
  | { kind: "serving"; servingG: number; servingMl: number }
  | { kind: "assumed" };

export interface FoodDraft {
  name: string;
  brand?: string;
  barcode?: string;
  basis: LabelBasis;
  servingSize?: number;
  servingUnit: "g" | "ml";
  servingLabel?: string;
  pieceLabel?: string;
  pieceG?: number;
  state: FoodFormState;
  energy?: { value: number; unit: "kcal" | "kJ" };
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  fibre_g?: number;
  sugar_g?: number;
  sat_fat_g?: number;
  sodium?: number;
  sodiumUnit: "mg" | "g";
  /** Other nutrients as printed, keyed like ingredient_micros (mg or µg as the key says). */
  micros?: Record<string, number>;
  density?: DensityChoice;
  ingredientsText?: string;
  isDairy: boolean;
  containsOnionGarlic: boolean;
  /** The person looked at the diet screen. Stored as a time on the food. */
  dietChecked: boolean;
}

// ---- Text to draft ----------------------------------------------------------------------------------------------

/** What the person typed in each field. Blank means "not reported". */
export interface FoodFormValues {
  name: string;
  brand: string;
  barcode: string;
  basis: LabelBasis;
  servingSize: string;
  servingUnit: "g" | "ml";
  servingLabel: string;
  pieceLabel: string;
  pieceG: string;
  state: FoodFormState;
  energy: string;
  energyUnit: "kcal" | "kJ";
  protein: string;
  carbs: string;
  fat: string;
  fibre: string;
  sugars: string;
  satFat: string;
  sodium: string;
  sodiumUnit: "mg" | "g";
  micros: Record<string, string>;
  densityKind: "none" | "pack" | "serving" | "assumed";
  packNetG: string;
  packVolumeMl: string;
  servingWeighG: string;
  servingVolumeMl: string;
  ingredientsText: string;
  isDairy: boolean;
  containsOnionGarlic: boolean;
  dietChecked: boolean;
}

export function emptyFormValues(): FoodFormValues {
  return {
    name: "", brand: "", barcode: "", basis: "per_serving", servingSize: "", servingUnit: "g", servingLabel: "", pieceLabel: "", pieceG: "",
    state: "ready", energy: "", energyUnit: "kcal", protein: "", carbs: "", fat: "", fibre: "", sugars: "", satFat: "", sodium: "", sodiumUnit: "mg",
    micros: {}, densityKind: "none", packNetG: "", packVolumeMl: "", servingWeighG: "", servingVolumeMl: "", ingredientsText: "",
    isDairy: false, containsOnionGarlic: false, dietChecked: false,
  };
}

/** A number typed by a person. Blank is undefined ("not reported"); a comma is accepted as the decimal mark; text is NaN. */
export function parseTyped(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "") return undefined;
  return /^-?\d*\.?\d+$|^-?\d+\.$/.test(t) ? Number(t) : Number.NaN;
}

const blankToUndefined = (s: string): string | undefined => (s.trim() === "" ? undefined : s.trim());

export interface DraftParse {
  draft: FoodDraft;
  /** Fields whose text is not a number. The draft leaves them out. */
  parseErrors: Record<string, string>;
}

export function draftFromValues(v: FoodFormValues): DraftParse {
  const parseErrors: Record<string, string> = {};
  const num = (field: string, text: string): number | undefined => {
    const n = parseTyped(text);
    if (n !== undefined && Number.isNaN(n)) {
      parseErrors[field] = "Enter a number.";
      return undefined;
    }
    return n;
  };
  const energy = num("energy", v.energy);
  const servingSize = num("servingSize", v.servingSize);
  const micros: Record<string, number> = {};
  for (const [key, text] of Object.entries(v.micros)) {
    const n = num(key, text);
    if (n !== undefined) micros[key] = n;
  }
  let density: DensityChoice | undefined;
  if (v.densityKind === "pack") {
    const packNetG = num("packNetG", v.packNetG);
    const packVolumeMl = num("packVolumeMl", v.packVolumeMl);
    density = { kind: "pack", packNetG: packNetG ?? 0, packVolumeMl: packVolumeMl ?? 0 };
  } else if (v.densityKind === "serving") {
    const servingG = num("servingWeighG", v.servingWeighG);
    const typedMl = num("servingVolumeMl", v.servingVolumeMl);
    density = { kind: "serving", servingG: servingG ?? 0, servingMl: typedMl ?? (v.servingUnit === "ml" ? servingSize ?? 0 : 0) };
  } else if (v.densityKind === "assumed") density = { kind: "assumed" };

  const draft: FoodDraft = {
    name: v.name.trim(),
    basis: v.basis,
    servingUnit: v.servingUnit,
    state: v.state,
    sodiumUnit: v.sodiumUnit,
    isDairy: v.isDairy,
    containsOnionGarlic: v.containsOnionGarlic,
    dietChecked: v.dietChecked,
    ...(blankToUndefined(v.brand) ? { brand: blankToUndefined(v.brand) } : {}),
    ...(blankToUndefined(v.barcode) ? { barcode: normalizeBarcode(v.barcode) } : {}),
    ...(servingSize !== undefined ? { servingSize } : {}),
    ...(blankToUndefined(v.servingLabel) ? { servingLabel: blankToUndefined(v.servingLabel) } : {}),
    ...(blankToUndefined(v.pieceLabel) ? { pieceLabel: blankToUndefined(v.pieceLabel) } : {}),
    ...(energy !== undefined ? { energy: { value: energy, unit: v.energyUnit } } : {}),
    ...(Object.keys(micros).length ? { micros } : {}),
    ...(density ? { density } : {}),
    ...(blankToUndefined(v.ingredientsText) ? { ingredientsText: blankToUndefined(v.ingredientsText) } : {}),
  };
  const set = (key: "protein_g" | "carbs_g" | "fat_g" | "fibre_g" | "sugar_g" | "sat_fat_g" | "sodium" | "pieceG", field: string, text: string) => {
    const n = num(field, text);
    if (n !== undefined) draft[key] = n;
  };
  set("protein_g", "protein_g", v.protein);
  set("carbs_g", "carbs_g", v.carbs);
  set("fat_g", "fat_g", v.fat);
  set("fibre_g", "fibre_g", v.fibre);
  set("sugar_g", "sugar_g", v.sugars);
  set("sat_fat_g", "sat_fat_g", v.satFat);
  set("sodium", "sodium", v.sodium);
  set("pieceG", "pieceG", v.pieceG);
  return { draft, parseErrors };
}

const text = (n: number | undefined): string => (n === undefined ? "" : String(n));

/** The reverse of `draftFromValues`, for an edit form. */
export function valuesFromDraft(d: FoodDraft): FoodFormValues {
  const micros: Record<string, string> = {};
  for (const [key, n] of Object.entries(d.micros ?? {})) micros[key] = String(n);
  const density = d.density;
  return {
    name: d.name, brand: d.brand ?? "", barcode: d.barcode ?? "", basis: d.basis, servingSize: text(d.servingSize), servingUnit: d.servingUnit,
    servingLabel: d.servingLabel ?? "", pieceLabel: d.pieceLabel ?? "", pieceG: text(d.pieceG), state: d.state,
    energy: text(d.energy?.value), energyUnit: d.energy?.unit ?? "kcal", protein: text(d.protein_g), carbs: text(d.carbs_g), fat: text(d.fat_g),
    fibre: text(d.fibre_g), sugars: text(d.sugar_g), satFat: text(d.sat_fat_g), sodium: text(d.sodium), sodiumUnit: d.sodiumUnit, micros,
    densityKind: density ? density.kind : "none",
    packNetG: density?.kind === "pack" ? String(density.packNetG) : "", packVolumeMl: density?.kind === "pack" ? String(density.packVolumeMl) : "",
    servingWeighG: density?.kind === "serving" ? String(density.servingG) : "", servingVolumeMl: density?.kind === "serving" ? String(density.servingMl) : "",
    ingredientsText: d.ingredientsText ?? "", isDairy: d.isDairy, containsOnionGarlic: d.containsOnionGarlic, dietChecked: d.dietChecked,
  };
}

// ---- Evaluation ---------------------------------------------------------------------------------------------------

export interface Per100g {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fibre_g: number | null;
}

export interface FoodEvaluation {
  validation: LabelValidation;
  /** Hard problems by field: label rules plus what the form itself needs. Any entry blocks saving. */
  fieldErrors: Record<string, string>;
  /** Per 100 g, when the label could be converted. */
  per100g?: Per100g;
  /** Optional nutrients per 100 g, keyed like ingredient_micros. */
  micros: Record<string, number>;
  /** True when a figure depends on "treat 1 ml as 1 g". */
  estimated: boolean;
  density?: Density;
  servingG?: number;
  servingMl?: number;
  diet: DietScreen;
}

const REQUIRED_MESSAGE = "Required. Enter 0 if the label shows 0.";

function densityInput(choice: DensityChoice | undefined): DensityInput | undefined {
  if (!choice) return undefined;
  if (choice.kind === "pack") return { packNetG: choice.packNetG, packVolumeMl: choice.packVolumeMl };
  if (choice.kind === "serving") return { servingG: choice.servingG, servingMl: choice.servingMl };
  return { treatOneMlAsOneG: true };
}

/** True when the label is in millilitres, so a density is needed to get grams. */
export function needsDensity(d: Pick<FoodDraft, "basis" | "servingUnit">): boolean {
  return d.basis === "per_100ml" || (d.basis === "per_serving" && d.servingUnit === "ml");
}

const r2 = (n: number) => roundTo(n, 2);

export function evaluateDraft(draft: FoodDraft): FoodEvaluation {
  const fieldErrors: Record<string, string> = {};
  const fail = (field: string, message: string) => { fieldErrors[field] ??= message; };

  if (draft.name.trim() === "") fail("name", "Enter a name.");
  if (draft.barcode !== undefined && !isValidGtin(draft.barcode)) fail("barcode", "This barcode does not pass its check digit. Re-type it or leave it blank.");
  if (draft.pieceG !== undefined && !(draft.pieceG > 0)) fail("pieceG", "A piece must weigh more than 0 g.");

  const kcal = draft.energy ? convertAmount(draft.energy.value, draft.energy.unit, "kcal") : undefined;
  if (kcal === undefined) fail("energy", "Enter the energy.");
  for (const [key, value] of [["protein_g", draft.protein_g], ["carbs_g", draft.carbs_g], ["fat_g", draft.fat_g]] as const) {
    if (value === undefined) fail(key, REQUIRED_MESSAGE);
  }

  const validation = validateLabel({
    basis: draft.basis,
    servingUnit: draft.servingUnit,
    sodiumUnit: draft.sodiumUnit,
    ...(draft.servingSize !== undefined ? { servingSize: draft.servingSize } : {}),
    ...(draft.energy ? { energy: draft.energy } : {}),
    ...(draft.protein_g !== undefined ? { protein_g: draft.protein_g } : {}),
    ...(draft.carbs_g !== undefined ? { carbs_g: draft.carbs_g } : {}),
    ...(draft.fat_g !== undefined ? { fat_g: draft.fat_g } : {}),
    ...(draft.fibre_g !== undefined ? { fibre_g: draft.fibre_g } : {}),
    ...(draft.sugar_g !== undefined ? { sugar_g: draft.sugar_g } : {}),
    ...(draft.sodium !== undefined ? { sodium: draft.sodium } : {}),
  });
  for (const e of validation.errors) fail(e.field, e.message);
  for (const [key, n] of Object.entries(draft.micros ?? {})) if (!(n >= 0)) fail(key, "Values cannot be negative.");
  if (draft.sat_fat_g !== undefined && !(draft.sat_fat_g >= 0)) fail("sat_fat_g", "Values cannot be negative.");

  // Density, then the other serving measure.
  const input = densityInput(draft.density);
  const density = input ? resolveDensity(input) : undefined;
  if (input && !density) fail("density", "Enter both the weight and the volume, each more than 0.");
  if (needsDensity(draft) && !density && !fieldErrors.density) fail("density", "Millilitres need a weight. Use the pack, a weighed serving, or treat 1 ml as 1 g.");
  let servingG: number | undefined;
  let servingMl: number | undefined;
  if (draft.servingSize !== undefined && draft.servingSize > 0) {
    if (draft.servingUnit === "g") {
      servingG = draft.servingSize;
      if (density) servingMl = draft.servingSize / density.gPerMl;
    } else {
      servingMl = draft.servingSize;
      if (density) servingG = draft.servingSize * density.gPerMl;
    }
  }

  // Convert to per 100 g.
  const sodiumMg = draft.sodium === undefined ? undefined : convertAmount(draft.sodium, draft.sodiumUnit, "mg");
  const amounts: Record<string, number | undefined> = {
    kcal, protein_g: draft.protein_g, carbs_g: draft.carbs_g, fat_g: draft.fat_g, fibre_g: draft.fibre_g,
    sugars_g: draft.sugar_g, sat_fat_g: draft.sat_fat_g, sodium_mg: sodiumMg, ...(draft.micros ?? {}),
  };
  let per100g: Per100g | undefined;
  const micros: Record<string, number> = {};
  let estimated = false;
  const converted = labelToPer100g(amounts, {
    basis: draft.basis,
    servingUnit: draft.servingUnit,
    ...(draft.servingSize !== undefined ? { servingSize: draft.servingSize } : {}),
    ...(density ? { density } : {}),
  });
  // A refusal here (no serving size, no density) was already reported against its own field above.
  if (converted.ok) {
    estimated = converted.estimated;
    const c = converted.per100g;
    if (c.kcal !== undefined && c.protein_g !== undefined && c.carbs_g !== undefined && c.fat_g !== undefined) {
      per100g = { kcal: roundTo(c.kcal, 1), protein_g: r2(c.protein_g), carbs_g: r2(c.carbs_g), fat_g: r2(c.fat_g), fibre_g: c.fibre_g === undefined ? null : r2(c.fibre_g) };
    }
    for (const [key, value] of Object.entries(c)) {
      if (["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g"].includes(key) || value === undefined || !Number.isFinite(value)) continue;
      micros[key] = roundTo(value, 3);
    }
  }
  if (Object.keys(fieldErrors).length > 0) per100g = undefined;

  return {
    validation, fieldErrors, micros, estimated, diet: screenIngredients(draft.ingredientsText ?? ""),
    ...(per100g ? { per100g } : {}), ...(density ? { density } : {}),
    ...(servingG !== undefined ? { servingG: roundTo(servingG, 2) } : {}), ...(servingMl !== undefined ? { servingMl: roundTo(servingMl, 2) } : {}),
  };
}

/** Saving is allowed with no hard problem and, when there are warnings, the person's confirmation. */
export function canSaveDraft(e: FoodEvaluation, checkedAgainstLabel: boolean): boolean {
  return Object.keys(e.fieldErrors).length === 0 && canSave(e.validation, checkedAgainstLabel);
}

// ---- Stored record ----------------------------------------------------------------------------------------------

export type FoodSourceKind = "LABEL" | "OFF" | "MANUAL";

/** The numbers as printed, kept with the food so the edit form shows what is on the pack, not the converted figures. */
export function labelValuesOf(d: FoodDraft): Record<string, unknown> {
  return {
    basis: d.basis, serving_unit: d.servingUnit, sodium_unit: d.sodiumUnit,
    ...(d.servingSize !== undefined ? { serving_size: d.servingSize } : {}),
    ...(d.energy ? { energy: d.energy } : {}),
    ...(d.protein_g !== undefined ? { protein_g: d.protein_g } : {}),
    ...(d.carbs_g !== undefined ? { carbs_g: d.carbs_g } : {}),
    ...(d.fat_g !== undefined ? { fat_g: d.fat_g } : {}),
    ...(d.fibre_g !== undefined ? { fibre_g: d.fibre_g } : {}),
    ...(d.sugar_g !== undefined ? { sugar_g: d.sugar_g } : {}),
    ...(d.sat_fat_g !== undefined ? { sat_fat_g: d.sat_fat_g } : {}),
    ...(d.sodium !== undefined ? { sodium: d.sodium } : {}),
    ...(d.micros && Object.keys(d.micros).length ? { micros: d.micros } : {}),
    ...(d.density ? { density: d.density } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Rebuilds the draft of a stored food from its printed label values and its other columns. */
export function draftFromStored(food: {
  name: string; brand: string | null; barcode: string | null; state: FoodFormState; labelBasis: LabelBasis; labelValues: Record<string, unknown>;
  servingLabel: string | null; pieceLabel: string | null; pieceG: number | null; ingredientsText: string | null; isDairy: boolean;
  containsOnionGarlic: boolean; dietCheckedAt: string | null; kcal: number; proteinG: number; carbsG: number; fatG: number; fibreG: number | null;
}): FoodDraft {
  const lv = food.labelValues;
  const hasPrinted = isRecord(lv.energy) && typeof lv.basis === "string";
  const servingUnit = lv.serving_unit === "ml" ? "ml" : "g";
  const sodiumUnit = lv.sodium_unit === "g" ? "g" : "mg";
  const energyRaw = isRecord(lv.energy) ? lv.energy : undefined;
  const energyValue = finite(energyRaw?.value);
  const micros: Record<string, number> = {};
  if (isRecord(lv.micros)) for (const [k, v] of Object.entries(lv.micros)) { const n = finite(v); if (n !== undefined) micros[k] = n; }
  let density: DensityChoice | undefined;
  const dr = isRecord(lv.density) ? lv.density : undefined;
  if (dr?.kind === "pack") density = { kind: "pack", packNetG: finite(dr.packNetG) ?? 0, packVolumeMl: finite(dr.packVolumeMl) ?? 0 };
  else if (dr?.kind === "serving") density = { kind: "serving", servingG: finite(dr.servingG) ?? 0, servingMl: finite(dr.servingMl) ?? 0 };
  else if (dr?.kind === "assumed") density = { kind: "assumed" };

  const draft: FoodDraft = {
    name: food.name, state: food.state, servingUnit, sodiumUnit, isDairy: food.isDairy, containsOnionGarlic: food.containsOnionGarlic,
    dietChecked: food.dietCheckedAt !== null,
    // A food without printed values (for example one imported from another source) is shown as per 100 g.
    basis: hasPrinted ? food.labelBasis : "per_100g",
    ...(food.brand ? { brand: food.brand } : {}),
    ...(food.barcode ? { barcode: food.barcode } : {}),
    ...(food.servingLabel ? { servingLabel: food.servingLabel } : {}),
    ...(food.pieceLabel ? { pieceLabel: food.pieceLabel } : {}),
    ...(food.pieceG !== null ? { pieceG: food.pieceG } : {}),
    ...(food.ingredientsText ? { ingredientsText: food.ingredientsText } : {}),
    ...(hasPrinted && energyValue !== undefined ? { energy: { value: energyValue, unit: energyRaw?.unit === "kJ" ? "kJ" as const : "kcal" as const } } : { energy: { value: food.kcal, unit: "kcal" as const } }),
    ...(Object.keys(micros).length ? { micros } : {}),
    ...(density ? { density } : {}),
  };
  const fill = (key: "protein_g" | "carbs_g" | "fat_g" | "fibre_g" | "sugar_g" | "sat_fat_g" | "sodium", fallback?: number | null) => {
    const n = hasPrinted ? finite(lv[key]) : fallback ?? undefined;
    if (n !== undefined) draft[key] = n;
  };
  fill("protein_g", food.proteinG);
  fill("carbs_g", food.carbsG);
  fill("fat_g", food.fatG);
  fill("fibre_g", food.fibreG);
  fill("sugar_g");
  fill("sat_fat_g");
  fill("sodium");
  const size = hasPrinted ? finite(lv.serving_size) : undefined;
  if (size !== undefined) draft.servingSize = size;
  return draft;
}

export interface BuildOptions {
  /** A label photo is attached (already, or in this request). Decides the source. */
  hasLabelPhoto: boolean;
  checkedAgainstLabel: boolean;
  now: Date;
}

export type BuildResult =
  | { ok: true; input: HouseholdFoodInputData; evaluation: FoodEvaluation; estimated: boolean }
  | { ok: false; message: string; fieldErrors: Record<string, string>; evaluation: FoodEvaluation };

/** Builds the record the household-foods writer stores, from a draft. Refuses hard errors and unconfirmed warnings. */
export function buildFoodRecord(draft: FoodDraft, options: BuildOptions): BuildResult {
  const evaluation = evaluateDraft(draft);
  const { fieldErrors, per100g } = evaluation;
  if (Object.keys(fieldErrors).length > 0 || !per100g) {
    const first = Object.values(fieldErrors)[0] ?? "The label could not be converted to per 100 g.";
    return { ok: false, message: first, fieldErrors, evaluation };
  }
  if (!canSave(evaluation.validation, options.checkedAgainstLabel)) {
    return {
      ok: false, message: "Check the highlighted values against the label, then tick the box to confirm.",
      fieldErrors: Object.fromEntries(evaluation.validation.warnings.map((w) => [w.field, w.message])), evaluation,
    };
  }

  const fieldOrigins: Record<string, string> = { kcal: "typed", proteinG: "typed", carbsG: "typed", fatG: "typed" };
  if (draft.fibre_g !== undefined) fieldOrigins.fibreG = "typed";
  for (const key of Object.keys(evaluation.micros)) fieldOrigins[key] = "typed";
  if (evaluation.density) fieldOrigins.densityGPerMl = evaluation.density.source;

  const reported = new Set(Object.keys(evaluation.micros));
  const labelValues = labelValuesOf(draft);
  if (evaluation.estimated) labelValues.density_estimated = true;
  const flags = [...new Set(evaluation.diet.flags.map((f) => f.label))];
  const pieceLabel = draft.pieceG !== undefined ? draft.pieceLabel ?? "piece" : draft.pieceLabel;

  return {
    ok: true, estimated: evaluation.estimated, evaluation,
    input: {
      name: draft.name.trim(), brand: draft.brand ?? null, barcode: draft.barcode ?? null, state: draft.state, aisle: "packaged",
      kcal: per100g.kcal, proteinG: per100g.protein_g, carbsG: per100g.carbs_g, fatG: per100g.fat_g, fibreG: per100g.fibre_g,
      per100gMicros: evaluation.micros, notReported: ALL_MICRO_KEYS.filter((k) => !reported.has(k)),
      servingLabel: draft.servingLabel ?? null, servingG: evaluation.servingG ?? null, servingMl: evaluation.servingMl ?? null,
      densityGPerMl: evaluation.density ? roundTo(evaluation.density.gPerMl, 4) : null, pieceLabel: pieceLabel ?? null, pieceG: draft.pieceG ?? null,
      labelBasis: draft.basis, labelValues, source: options.hasLabelPhoto ? "LABEL" : "MANUAL", sourceId: null, fieldOrigins,
      ingredientsText: draft.ingredientsText ?? null, isDairy: draft.isDairy, containsOnionGarlic: draft.containsOnionGarlic,
      dietFlagsFound: flags, dietCheckedAt: draft.dietChecked ? options.now.toISOString() : null,
    },
  };
}

// ---- Display ----------------------------------------------------------------------------------------------------

export function sourceBadge(source: FoodSourceKind): { text: string; tone: "ok" | "info" | "warn" } {
  if (source === "LABEL") return { text: "From label, confirmed", tone: "ok" };
  if (source === "OFF") return { text: "From Open Food Facts, checked", tone: "info" };
  return { text: "Typed by you, no label", tone: "warn" };
}

/** True when the food's weight per millilitre is the "1 ml = 1 g" guess. */
export function isEstimatedWeight(fieldOrigins: Record<string, string>): boolean {
  return fieldOrigins.densityGPerMl === "assumed_water";
}
