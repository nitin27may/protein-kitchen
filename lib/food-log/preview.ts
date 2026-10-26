/**
 * What the add sheet shows for a food and an amount, before anything is saved. Pure.
 */
import { loggedAmountToGrams, type FoodPortions, type LoggedUnit } from "../foods/units";
import { emptyTotals, type NutrientsPer, type Totals } from "../foods/totals";
import { liveLine, quantityText, trimNumber } from "./format";

export type SheetFoodKind = "ingredient" | "household" | "recipe";

/** One searchable item in the add sheet. Foods carry per 100 g values; a recipe carries per serving values. */
export interface SheetFood {
  /** Catalog key: an ingredient slug, `hf:<uid>`, or `recipe:<slug>`. */
  key: string;
  kind: SheetFoodKind;
  name: string;
  brand?: string;
  /** dry, cooked, raw or ready: grams are in this state. */
  state?: string;
  aliases?: string[];
  nutrients: NutrientsPer;
  servingG?: number;
  servingLabel?: string;
  pieceG?: number;
  pieceLabel?: string;
  densityGPerMl?: number;
  densityEstimated?: boolean;
}

export const RECIPE_PREFIX = "recipe:";

export function portionsOf(food: SheetFood): FoodPortions {
  return {
    ...(food.servingG !== undefined ? { servingG: food.servingG } : {}),
    ...(food.pieceG !== undefined ? { pieceG: food.pieceG } : {}),
    ...(food.densityGPerMl !== undefined ? { densityGPerMl: food.densityGPerMl } : {}),
    ...(food.densityEstimated !== undefined ? { densityEstimated: food.densityEstimated } : {}),
  };
}

/** Units the person can type this food in. A recipe is eaten by the serving, an ingredient by weight. */
export function unitsFor(food: SheetFood): LoggedUnit[] {
  if (food.kind === "recipe") return ["serving"];
  const units: LoggedUnit[] = ["g"];
  if (food.servingG !== undefined) units.push("serving");
  if (food.pieceG !== undefined) units.push("piece");
  if (food.densityGPerMl !== undefined) units.push("ml");
  return units;
}

/** The unit and quantity the sheet starts with. */
export function defaultAmount(food: SheetFood): { qty: number; unit: LoggedUnit } {
  if (food.kind === "recipe") return { qty: 1, unit: "serving" };
  if (food.servingG !== undefined) return { qty: 1, unit: "serving" };
  if (food.pieceG !== undefined) return { qty: 1, unit: "piece" };
  return { qty: 100, unit: "g" };
}

export type Preview =
  | { ok: true; grams: number | null; servings: number | null; estimated: boolean; totals: Totals; line: string }
  | { ok: false; reason: string };

function scaled(n: NutrientsPer, factor: number): Totals {
  const t = emptyTotals();
  t.kcal = n.kcal * factor;
  t.protein_g = n.protein_g * factor;
  t.carbs_g = n.carbs_g * factor;
  t.fat_g = n.fat_g * factor;
  if (n.fibre_g === undefined) {
    t.fibre_at_least = true;
    t.fibre_not_reported_count = 1;
  } else {
    t.fibre_g = n.fibre_g * factor;
  }
  return t;
}

/** Totals and the live line for `qty` of `unit`. Refuses when the unit needs a size the food does not have. */
export function previewAmount(food: SheetFood, qty: number, unit: LoggedUnit): Preview {
  if (food.kind === "recipe") {
    if (unit !== "serving" || !(qty > 0)) return { ok: false, reason: "Amount must be more than zero." };
    const totals = scaled(food.nutrients, qty);
    return { ok: true, grams: null, servings: qty, estimated: false, totals, line: liveLine(quantityText(qty, "serving"), totals) };
  }
  const result = loggedAmountToGrams({ qty, unit }, portionsOf(food));
  if (!result.ok) return { ok: false, reason: result.reason };
  const totals = scaled(food.nutrients, result.grams / 100);
  const amount = unit === "g" ? `${trimNumber(result.grams)} g` : `${quantityText(qty, unit)} (${trimNumber(result.grams)} g)`;
  const line = liveLine(amount, totals) + (result.estimated ? " · estimated from a density guess" : "");
  return { ok: true, grams: result.grams, servings: null, estimated: result.estimated, totals, line };
}

/** Slot for the time of day: breakfast until 10:00, lunch until 15:00, dinner until 21:00, snack after. */
export function defaultSlot(minutesSinceMidnight: number): "breakfast" | "lunch" | "dinner" | "snack" {
  if (minutesSinceMidnight < 600) return "breakfast";
  if (minutesSinceMidnight < 900) return "lunch";
  if (minutesSinceMidnight < 1260) return "dinner";
  return "snack";
}
