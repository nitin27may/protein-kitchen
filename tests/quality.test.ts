import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import type { DataSet } from "../lib/data/load";
import { isLight, isLowSugar, nutrientDenseSet, qualityPerServing } from "../lib/nutrition/quality";
import type { Quality } from "../lib/nutrition/quality";
import { perServing } from "../lib/nutrition/macros";

let data: DataSet;
const q = (slug: string): Quality => qualityPerServing(slug, perServing(slug, data.recipes, data.ingredients), data.recipes, data.ingredients, data.micros);

beforeAll(() => {
  data = loadData(path.resolve(__dirname, ".."));
});

const make = (over: Partial<Quality>): Quality => ({ kcal: 300, totalSugarG: 5, freeSugarG: 0, sodiumMg: 200, satFatG: 2, amounts: {}, score: 50, partial: false, ...over });

describe("thresholds", () => {
  it("treats free sugars at or under 5 percent of energy as low", () => {
    expect(isLowSugar(make({ kcal: 400, freeSugarG: 5 }))).toBe(true); // 20 kcal of 400 = 5 percent
    expect(isLowSugar(make({ kcal: 400, freeSugarG: 6 }))).toBe(false);
    expect(isLowSugar(make({ kcal: 100, freeSugarG: 0 }))).toBe(true);
  });
  it("uses a stricter calorie ceiling for snacks", () => {
    expect(isLight(make({ kcal: 210 }), "snack")).toBe(true);
    expect(isLight(make({ kcal: 300 }), "snack")).toBe(false);
    expect(isLight(make({ kcal: 300 }), "dinner")).toBe(true);
  });
  it("picks the top third by score", () => {
    const set = nutrientDenseSet(new Map([["a", 90], ["b", 10], ["c", 50], ["d", 70], ["e", 30], ["f", 20]]));
    expect([...set].sort()).toEqual(["a", "d"]);
  });
});

describe("recipe quality", () => {
  it("counts honey as a free sugar and fruit and milk as not", () => {
    const seed = q("greek-yogurt-seed-bowl"); // contains 8 g honey
    expect(seed.freeSugarG).toBeGreaterThan(5);
    const bowl = q("savoury-yogurt-bowl"); // yogurt and cucumber only
    expect(bowl.freeSugarG).toBe(0);
    expect(bowl.totalSugarG).toBeGreaterThan(0); // milk sugar is still total sugar
  });
  it("counts dates blended into a snack as free sugar", () => {
    expect(isLowSugar(q("oat-peanut-energy-balls"))).toBe(false);
  });
  it("scores a vegetable and legume soup above a sweet nut snack", () => {
    expect(q("red-lentil-tomato-soup").score).toBeGreaterThan(q("oat-peanut-energy-balls").score);
  });
  it("returns finite numbers for every recipe", () => {
    for (const r of data.recipes.values()) {
      if (r.kind !== "recipe") continue;
      const x = q(r.slug);
      expect(Number.isFinite(x.score), r.slug).toBe(true);
      expect(x.freeSugarG).toBeGreaterThanOrEqual(0);
    }
  });
});
