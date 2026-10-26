import { describe, expect, it } from "vitest";
import { loadData } from "@/lib/data/load";
import { recipeDetailFromLibrary } from "@/lib/library/recipe-detail";
import { TARGETS } from "@/lib/nutrition/dri";
import { formatAmount, formatPct, splitZeros } from "@/lib/nutrition/display";
import { microsPerServing } from "@/lib/nutrition/micros";

describe("formatAmount", () => {
  it("shows a positive value below the precision as a bound", () => {
    expect(formatAmount(0.4, 0)).toBe("<1");
    expect(formatAmount(0.004, 2)).toBe("<0.01");
    expect(formatAmount(0.04, 1)).toBe("<0.1");
  });
  it("rounds at or above half a unit", () => {
    expect(formatAmount(0.5, 0)).toBe("1");
    expect(formatAmount(1234.56, 1)).toBe("1,234.6");
    expect(formatAmount(0, 1)).toBe("0");
  });
});

describe("formatPct", () => {
  it("returns null without a target", () => expect(formatPct(null)).toBeNull());
  it("reads <1 for a positive share under half a percent", () => {
    expect(formatPct(0.3)).toBe("<1");
    expect(formatPct(0.5)).toBe("1");
    expect(formatPct(0)).toBe("0");
    expect(formatPct(42.4)).toBe("42");
  });
});

describe("splitZeros", () => {
  it("moves exact zeros to a label list and keeps the rest", () => {
    const rows = [{ label: "Vitamin D", v: 0 }, { label: "Iron", v: 8.2 }, { label: "Cholesterol", v: 0 }, { label: "Sodium", v: 0.2 }];
    const { shown, none } = splitZeros(rows, (r) => r.v);
    expect(none).toEqual(["Vitamin D", "Cholesterol"]);
    expect(shown.map((r) => r.label)).toEqual(["Iron", "Sodium"]);
  });
  it("never sees an unreported nutrient, so there is nothing to omit", () => {
    expect(splitZeros([], (r: { label: string; v: number }) => r.v)).toEqual({ shown: [], none: [] });
  });
});

describe("recipe nutrients", () => {
  const data = loadData(process.cwd());
  const keys = TARGETS.filter((t) => t.key !== "fibre_g").map((t) => t.key);

  it("hides a zero total when some ingredient has no value, and never marks a zero as partial", () => {
    let hiddenChecked = 0;
    for (const [slug, r] of data.recipes) {
      if (r.kind === "routine") continue;
      const detail = recipeDetailFromLibrary(data, slug, { sex: "male", targetLabel: "man", ingredientPhotos: new Map(), dense: false });
      for (const n of detail.nutrients) expect(n.partial && n.amount === 0, `${slug} ${n.label}`).toBe(false);
      for (const m of microsPerServing(slug, data.recipes, data.ingredients, data.micros, keys)) {
        if (m.amount === 0 && m.missingFrom.length > 0) {
          const label = TARGETS.find((t) => t.key === m.key)!.label;
          expect(detail.nutrients.some((n) => n.label === label), `${slug} ${label}`).toBe(false);
          hiddenChecked++;
        }
      }
    }
    expect(hiddenChecked).toBeGreaterThan(0);
  });
});
