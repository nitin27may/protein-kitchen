import type { Totals } from "../foods/totals";

const round = (n: number) => Math.round(n);

/** 1.5 stays 1.5, 2 reads 2: at most one decimal. */
export function trimNumber(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * Fibre wording for a total. Missing is not zero: when an item does not report fibre the figure is a floor, and a total
 * with nothing reported says so instead of showing 0.
 */
export function fibreText(t: Pick<Totals, "fibre_g" | "fibre_at_least" | "fibre_not_reported_count">): string {
  if (!t.fibre_at_least) return `${trimNumber(t.fibre_g)} g fibre`;
  if (t.fibre_g <= 0) return "fibre not reported";
  return `at least ${trimNumber(t.fibre_g)} g fibre (${t.fibre_not_reported_count} not reported)`;
}

export type AmountUnit = "g" | "serving" | "piece" | "ml";

export function unitWord(unit: AmountUnit, qty: number): string {
  if (unit === "g" || unit === "ml") return unit;
  if (unit === "serving") return qty === 1 ? "serving" : "servings";
  return qty === 1 ? "piece" : "pieces";
}

/** `2 servings`, `3 pieces`, `110 g`. */
export function quantityText(qty: number, unit: AmountUnit): string {
  return `${trimNumber(qty)} ${unitWord(unit, qty)}`;
}

/**
 * The live line under the quantity field: `110 g · 14 g protein · 260 kcal`. Fibre appears only when it is not fully
 * reported, with the "at least" wording.
 */
export function liveLine(amountText: string, t: Totals): string {
  const parts = [amountText, `${round(t.protein_g)} g protein`, `${round(t.kcal)} kcal`];
  if (t.fibre_at_least) parts.push(fibreText(t));
  return parts.join(" · ");
}

/** `Eaten 62 g, 48 g still planned, target 120 g`. */
export function proteinCaption(eatenG: number, pendingG: number, targetG: number): string {
  return pendingG >= 0.5
    ? `Eaten ${round(eatenG)} g, ${round(pendingG)} g still planned, target ${round(targetG)} g`
    : `Eaten ${round(eatenG)} g, nothing still planned, target ${round(targetG)} g`;
}

export interface Averages {
  loggedDays: number;
  totalDays: number;
  averageG: number | null;
  targetG: number;
}

/** `Eaten protein: 3 of 7 days logged, average 98 g against 120 g` (logged days only). */
export function eatenSummaryLine(a: Averages): string {
  const base = `Eaten protein: ${a.loggedDays} of ${a.totalDays} days logged`;
  return a.averageG === null ? base : `${base}, average ${round(a.averageG)} g against ${round(a.targetG)} g`;
}
