import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { perServing } from "../lib/nutrition/macros";

const data = loadData(path.resolve(__dirname, ".."));

describe("data set", () => {
  it("loads with no schema or file issues", () => {
    expect(data.issues).toEqual([]);
  });

  it("has a source and id on every ingredient", () => {
    for (const ing of data.ingredients.values()) expect(ing.source_id.length).toBeGreaterThan(0);
  });

  it("computes finite macros for every recipe", () => {
    for (const r of data.recipes.values()) {
      const m = perServing(r.slug, data.recipes, data.ingredients);
      expect(Number.isFinite(m.kcal)).toBe(true);
      expect(m.kcal).toBeGreaterThan(0);
    }
  });

  it("keeps the toor dal entry on the mature dry pea, not the fresh pea", () => {
    expect(data.ingredients.get("toor-dal-pigeon-peas")?.per100g.protein_g).toBeGreaterThan(20);
  });
});
