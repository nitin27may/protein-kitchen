import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { buildPlanExport, weeksOf, type ExportInput } from "../lib/export/model";
import { buildWorkbook } from "../lib/export/xlsx";
import { buildPdf } from "../lib/export/pdf";

const data = loadData(path.resolve(__dirname, ".."));

function input(days: number): ExportInput {
  const start = "2026-11-02";
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const slots = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    slots.push({ date, slot: "lunch", recipeSlug: "dal-tadka", servings: { "1": 1, "2": 0.5 } });
    slots.push({ date, slot: "breakfast", recipeSlug: "roti-whole-wheat", servings: { "1": 1 } });
  }
  return {
    startDate: start,
    endDate: end,
    generatedOn: "2026-11-01",
    people: [{ id: 1, name: "A", proteinTargetG: 100, kcalTarget: null }, { id: 2, name: "B", proteinTargetG: 70, kcalTarget: 1800 }],
    slots,
    recipes: data.recipes,
    ingredients: data.ingredients,
    micros: data.micros,
  };
}

describe("weeksOf", () => {
  it("splits into 7-day weeks, last one short", () => {
    const w = weeksOf("2026-11-02", "2026-11-16");
    expect(w.map((x) => [x.from, x.to])).toEqual([["2026-11-02", "2026-11-08"], ["2026-11-09", "2026-11-15"], ["2026-11-16", "2026-11-16"]]);
  });
});

describe("buildPlanExport", () => {
  const plan = buildPlanExport(input(14));
  it("has a row per person per meal, skipping people with no portion", () => {
    expect(plan.meals.length).toBe(14 * 3);
    expect(plan.meals.filter((m) => m.person === "B" && m.slot === "Breakfast")).toHaveLength(0);
  });
  it("assigns weeks and totals each day per person", () => {
    expect(plan.weeks).toHaveLength(2);
    expect(plan.meals.filter((m) => m.week === 2)).toHaveLength(7 * 3);
    const day = plan.days.find((d) => d.person === "A" && d.date === "2026-11-02")!;
    const rows = plan.meals.filter((m) => m.person === "A" && m.date === "2026-11-02");
    expect(day.protein_g).toBeCloseTo(rows.reduce((s, r) => s + r.protein_g, 0), 0);
    expect(day.proteinPct).toBe(Math.round((day.protein_g / 100) * 100));
  });
  it("shows pieces for countable recipes and grams otherwise", () => {
    expect(plan.meals.find((m) => m.recipe.startsWith("Roti"))!.portion).toBe("2 rotis");
    expect(plan.meals.find((m) => m.slot === "Lunch")!.portion).toMatch(/^about \d+ g$/);
  });
  it("splits the grocery list by week and the weeks add up to the total", () => {
    for (const g of plan.grocery) {
      expect(g.weekG).toHaveLength(2);
      expect(Math.abs(g.weekG.reduce((a, b) => a + b, 0) - g.needG)).toBeLessThanOrEqual(2);
    }
  });
});

describe("file builders", () => {
  it("writes a workbook with one sheet per week plus totals and groceries", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const buf = await buildWorkbook(buildPlanExport(input(14)));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Week 1", "Week 2", "Daily totals", "Groceries"]);
  });
  it("writes a PDF", async () => {
    const buf = await buildPdf(buildPlanExport(input(7)));
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
