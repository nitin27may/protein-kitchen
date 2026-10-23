import ExcelJS from "exceljs";
import { NUTRIENT_COLS, type DayRow, type MealRow, type PlanExport } from "./model";

const TEAL = "FF0F6B7A";
const TEAL_SOFT = "FFDCF0F3";
const GREY = "FF55666F";
const FONT = { name: "Calibri", size: 11 };

const fmtOf = (digits: number) => (digits === 0 ? "#,##0" : `#,##0.${"0".repeat(digits)}`);
const head = (c: { header: string; unit: string }) => `${c.header} (${c.unit})`;

function titleBlock(ws: ExcelJS.Worksheet, title: string, sub: string): void {
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { ...FONT, size: 16, bold: true, color: { argb: TEAL } };
  ws.getCell("A2").value = sub;
  ws.getCell("A2").font = { ...FONT, size: 10, color: { argb: GREY } };
}

function finishSheet(ws: ExcelJS.Worksheet, headerRow: number, frozenCols: number, widths: number[]): void {
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.views = [{ state: "frozen", xSplit: frozenCols, ySplit: headerRow, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: `${headerRow}:${headerRow}`, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  ws.headerFooter = { oddFooter: "&L&A&RPage &P of &N" };
}

function addTable(ws: ExcelJS.Worksheet, name: string, row: number, columns: string[], rows: (string | number | boolean | null)[][]): void {
  ws.addTable({
    name,
    ref: `A${row}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: columns.map((c) => ({ name: c, filterButton: true })),
    rows,
  });
  const header = ws.getRow(row);
  header.height = 32;
  header.eachCell((cell) => {
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.font = { ...FONT, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
  });
}

const mealCells = (r: MealRow): (string | number | boolean | null)[] => [
  r.day, r.slot, r.recipe, r.person, r.portion, r.servings, r.weightG, ...NUTRIENT_COLS.map((c) => r[c.key]),
  r.leftover ? "Leftover" : "", r.partial ? "Micros are lower bounds" : "",
];

const dayCells = (r: DayRow): (string | number | boolean | null)[] => [
  r.day, r.person, r.meals, ...NUTRIENT_COLS.map((c) => r[c.key]), r.proteinTargetG, r.proteinPct / 100, r.kcalTarget,
];

export async function buildWorkbook(plan: PlanExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Protein Kitchen";
  wb.created = new Date(`${plan.generatedOn}T12:00:00Z`);

  // Summary
  const sum = wb.addWorksheet("Summary", { properties: { tabColor: { argb: TEAL } } });
  titleBlock(sum, plan.title, `${plan.weeks.length} ${plan.weeks.length === 1 ? "week" : "weeks"}. Generated ${plan.generatedOn}.`);
  const peopleRows = plan.people.map((p) => {
    const avg = plan.averages.find((a) => a.person === p.name);
    return [p.name, p.proteinTargetG, avg?.protein_g ?? 0, (avg?.proteinPct ?? 0) / 100, p.kcalTarget, avg?.kcal ?? 0, avg?.fibre_g ?? 0, avg?.freeSugar_g ?? 0, avg?.sodium_mg ?? 0];
  });
  addTable(sum, "People", 4, ["Person", "Protein target (g)", "Avg protein (g/day)", "Avg % of target", "Energy target (kcal)", "Avg energy (kcal/day)", "Avg fibre (g/day)", "Avg free sugars (g/day)", "Avg sodium (mg/day)"], peopleRows);
  const pr = 5;
  peopleRows.forEach((_, i) => {
    const r = sum.getRow(pr + i);
    r.getCell(4).numFmt = "0%";
    [2, 3, 5, 6, 7, 8, 9].forEach((c) => (r.getCell(c).numFmt = "#,##0.#"));
  });
  let row = pr + peopleRows.length + 2;
  sum.getCell(`A${row}`).value = "Sheets";
  sum.getCell(`A${row}`).font = { ...FONT, bold: true };
  const guide = [
    ...plan.weeks.map((w) => [w.label, `Every meal for each person, ${w.from} to ${w.to}, with the portion and full nutrition.`]),
    ["Daily totals", "Each day per person with the protein target and percent reached."],
    ["Groceries", "Everything to buy, per week and in total, grouped by aisle."],
  ];
  for (const [a, b] of guide) {
    row++;
    sum.getCell(`A${row}`).value = a;
    sum.getCell(`B${row}`).value = b;
  }
  row += 2;
  sum.getCell(`A${row}`).value = "Notes";
  sum.getCell(`A${row}`).font = { ...FONT, bold: true };
  for (const n of plan.notes) {
    row++;
    sum.mergeCells(`A${row}:I${row}`);
    sum.getCell(`A${row}`).value = n;
    sum.getCell(`A${row}`).alignment = { wrapText: true, vertical: "top" };
    sum.getRow(row).height = 32;
  }
  sum.views = [{ showGridLines: false }];
  [18, 18, 20, 16, 20, 20, 16, 20, 18].forEach((w, i) => (sum.getColumn(i + 1).width = w));
  sum.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  // One sheet per week
  const mealHeaders = ["Day", "Meal", "Recipe", "Person", "Portion", "Servings", "Weight (g)", ...NUTRIENT_COLS.map(head), "Type", "Note"];
  for (const w of plan.weeks) {
    const ws = wb.addWorksheet(w.label);
    titleBlock(ws, `${w.label}: ${plan.weeks.length > 1 ? `${w.from} to ${w.to}` : plan.title}`, "Per person. Nutrition is for the portion shown, not per recipe serving.");
    const rows = plan.meals.filter((m) => m.week === w.n);
    addTable(ws, `Week${w.n}`, 4, mealHeaders, rows.map(mealCells));
    rows.forEach((_, i) => {
      const r = ws.getRow(5 + i);
      r.getCell(6).numFmt = "0.00";
      r.getCell(7).numFmt = "#,##0";
      NUTRIENT_COLS.forEach((c, j) => (r.getCell(8 + j).numFmt = fmtOf(c.digits)));
      r.getCell(3).alignment = { wrapText: true, vertical: "top" };
      r.getCell(9).font = { ...FONT, bold: true };
    });
    finishSheet(ws, 4, 4, [14, 11, 34, 12, 16, 10, 11, ...NUTRIENT_COLS.map(() => 12), 11, 26]);
  }

  // Daily totals
  const dt = wb.addWorksheet("Daily totals");
  titleBlock(dt, "Daily totals", "Sum of everything eaten that day, per person. Percent is protein against the person's target.");
  const dayHeaders = ["Day", "Person", "Meals", ...NUTRIENT_COLS.map(head), "Protein target (g)", "Protein % of target", "Energy target (kcal)"];
  const allDays = [...plan.days, ...plan.averages];
  addTable(dt, "DailyTotals", 4, dayHeaders, allDays.map(dayCells));
  const pctCol = 3 + NUTRIENT_COLS.length + 2;
  allDays.forEach((d, i) => {
    const r = dt.getRow(5 + i);
    NUTRIENT_COLS.forEach((c, j) => (r.getCell(4 + j).numFmt = fmtOf(c.digits)));
    r.getCell(pctCol).numFmt = "0%";
    if (!d.date) {
      r.eachCell((cell) => {
        cell.font = { ...FONT, bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL_SOFT } };
      });
    }
  });
  const colLetter = (n: number): string => (n > 26 ? colLetter(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(65 + ((n - 1) % 26));
  const pctRef = `${colLetter(pctCol)}5:${colLetter(pctCol)}${4 + allDays.length}`;
  dt.addConditionalFormatting({
    ref: pctRef,
    rules: [
      { type: "cellIs", operator: "lessThan", formulae: [0.9], priority: 1, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFBE3E1" } }, font: { color: { argb: "FFB3261E" } } } },
      { type: "cellIs", operator: "greaterThan", formulae: [0.8999], priority: 2, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFDFF3E8" } }, font: { color: { argb: "FF1F7A4D" } } } },
    ],
  });
  finishSheet(dt, 4, 2, [16, 12, 8, ...NUTRIENT_COLS.map(() => 12), 14, 14, 14]);

  // Groceries
  const gs = wb.addWorksheet("Groceries", { properties: { tabColor: { argb: "FF1F7A4D" } } });
  titleBlock(gs, "Grocery list", `${plan.title}. Raw weights; To buy rounds up to whole packs where the pack size is known.`);
  const weekHeads = plan.weeks.length > 1 ? plan.weeks.map((w) => `${w.label} (g)`) : [];
  const gHeaders = ["Aisle", "Item", "State", ...weekHeads, "Total needed (g)", "To buy (g)", "Packs", "Pack size (g)", "Pantry staple", "Where to buy", "Used in", "Got it"];
  addTable(gs, "Groceries", 4, gHeaders, plan.grocery.map((g) => [g.aisle, g.item, g.state, ...(plan.weeks.length > 1 ? g.weekG : []), g.needG, g.buyG, g.packs, g.packSizeG, g.pantry ? "Yes" : "", g.where, g.usedIn, ""]));
  const nWeek = weekHeads.length;
  plan.grocery.forEach((_, i) => {
    const r = gs.getRow(5 + i);
    for (let c = 4; c <= 3 + nWeek + 4; c++) r.getCell(c).numFmt = "#,##0";
    r.getCell(3 + nWeek + 7).alignment = { wrapText: true, vertical: "top" };
    gs.getCell(5 + i, gHeaders.length).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
  });
  finishSheet(gs, 4, 2, [14, 28, 9, ...weekHeads.map(() => 12), 14, 12, 8, 12, 10, 26, 44, 9]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
