import path from "node:path";
import { describe, expect, it } from "vitest";
import { portionText, quarterLabel, servingWeightG } from "../lib/nutrition/portion";
import { loadData } from "../lib/data/load";

describe("quarterLabel", () => {
  it("renders quarters", () => {
    expect(quarterLabel(0.25)).toBe("¼");
    expect(quarterLabel(1.5)).toBe("1½");
    expect(quarterLabel(2)).toBe("2");
    expect(quarterLabel(1.25 * 2)).toBe("2½");
  });
});

describe("portionText", () => {
  const roti = { singular: "roti", plural: "rotis", per_serving: 2 };
  it("shows pieces for countable recipes", () => {
    expect(portionText(1, 120, roti).amount).toBe("2 rotis");
    expect(portionText(1.25, 120, roti).amount).toBe("2½ rotis");
    expect(portionText(0.5, 120, roti).amount).toBe("1 roti");
  });
  it("shows grams otherwise", () => {
    const t = portionText(1.25, 248);
    expect(t.amount).toBe("about 310 g");
    expect(t.detail).toBe("1¼ servings");
  });
});

describe("servingWeightG", () => {
  it("counts dry ingredients at cooked weight", () => {
    const d = loadData(path.resolve(__dirname, ".."));
    const dal = servingWeightG("dal-tadka", d.recipes, d.ingredients);
    const raw = d.recipes.get("dal-tadka")!.items.reduce((s, i) => s + i.grams, 0) / d.recipes.get("dal-tadka")!.servings;
    expect(dal).toBeGreaterThan(raw);
    for (const slug of d.recipes.keys()) {
      if (d.recipes.get(slug)!.kind !== "recipe") continue;
      const g = servingWeightG(slug, d.recipes, d.ingredients);
      expect(g, slug).toBeGreaterThan(40);
      expect(g, slug).toBeLessThan(900);
    }
  });
});
