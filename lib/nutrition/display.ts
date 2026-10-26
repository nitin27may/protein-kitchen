/**
 * Display rules for nutrient amounts. Pure, shared by the ingredient page and the recipe page.
 *
 * - Not reported: the caller leaves the nutrient out (it never reaches these functions).
 * - Reported as exactly zero: not a tile; listed once per group as "None: ...".
 * - Positive but below the display precision: "<1", "<0.01" instead of a misleading "0".
 * - A percent of a daily need is shown only where a target exists.
 */

/** Format an amount at `digits` decimals. A positive value that would round to zero reads "<0.1", "<0.01" and so on. */
export function formatAmount(value: number, digits: number): string {
  const scale = 10 ** digits;
  if (value > 0 && Math.round(value * scale) === 0) return `<${(1 / scale).toLocaleString("en-CA", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return (Math.round(value * scale) / scale).toLocaleString("en-CA", { maximumFractionDigits: digits });
}

/** Percent of a daily need as text, or null when there is no target. Below half a percent reads "<1". */
export function formatPct(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct > 0 && pct < 0.5) return "<1";
  return String(Math.round(pct));
}

/** Split rows into those worth a tile and the labels of those the source reports as exactly zero. */
export function splitZeros<T extends { label: string }>(rows: readonly T[], valueOf: (row: T) => number): { shown: T[]; none: string[] } {
  const shown: T[] = [];
  const none: string[] = [];
  for (const row of rows) {
    if (valueOf(row) === 0) none.push(row.label);
    else shown.push(row);
  }
  return { shown, none };
}
