import { createRequire } from "node:module";
import path from "node:path";
import pdfmake from "pdfmake";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { NUTRIENT_COLS, type DayRow, type MealRow, type NutrientKey, type PlanExport } from "./model";

const TEAL = "#0f6b7a";
const SOFT = "#dcf0f3";
const MUTED = "#55666f";

let fontsReady = false;
export function ensureFonts(): void {
  if (fontsReady) return;
  const dir = path.join(path.dirname(createRequire(path.join(process.cwd(), "package.json")).resolve("pdfmake/package.json")), "build", "fonts", "Roboto");
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((file: string) => file.startsWith(dir));
  pdfmake.addFonts({
    Roboto: {
      normal: path.join(dir, "Roboto-Regular.ttf"),
      bold: path.join(dir, "Roboto-Medium.ttf"),
      italics: path.join(dir, "Roboto-Italic.ttf"),
      bolditalics: path.join(dir, "Roboto-MediumItalic.ttf"),
    },
  });
  fontsReady = true;
}

// Columns shown in the PDF. The Excel file carries the full set.
const PDF_NUTRIENTS: { key: NutrientKey; label: string; digits: number }[] = [
  { key: "kcal", label: "kcal", digits: 0 },
  { key: "protein_g", label: "Protein g", digits: 1 },
  { key: "carbs_g", label: "Carbs g", digits: 1 },
  { key: "fat_g", label: "Fat g", digits: 1 },
  { key: "fibre_g", label: "Fibre g", digits: 1 },
  { key: "freeSugar_g", label: "Free sugar g", digits: 1 },
  { key: "sodium_mg", label: "Sodium mg", digits: 0 },
  { key: "calcium_mg", label: "Calcium mg", digits: 0 },
  { key: "iron_mg", label: "Iron mg", digits: 1 },
  { key: "b12_ug", label: "B12 µg", digits: 2 },
];

const num = (n: number, d: number) => n.toLocaleString("en-CA", { minimumFractionDigits: d, maximumFractionDigits: d });
const th = (text: string, align: "left" | "right" = "right"): TableCell => ({ text, bold: true, color: "#ffffff", fillColor: TEAL, fontSize: 8, alignment: align, margin: [0, 2, 0, 2] });

function dayTable(date: string, label: string, meals: MealRow[], totals: DayRow[]): Content {
  const header: TableCell[] = [th("Meal", "left"), th("Recipe", "left"), th("Person", "left"), th("Portion", "left"), ...PDF_NUTRIENTS.map((n) => th(n.label))];
  const body: TableCell[][] = meals.map((m) => [
    { text: m.slot, fontSize: 8 },
    { text: m.leftover ? `${m.recipe} (leftover)` : m.recipe, fontSize: 8 },
    { text: m.person, fontSize: 8 },
    { text: m.portion, fontSize: 8 },
    ...PDF_NUTRIENTS.map((n) => ({ text: num(m[n.key], n.digits), fontSize: 8, alignment: "right" as const })),
  ]);
  for (const t of totals) {
    body.push([
      { text: "Day total", bold: true, fontSize: 8, fillColor: SOFT },
      { text: `${t.proteinPct}% of ${t.proteinTargetG} g protein target`, fontSize: 8, color: MUTED, fillColor: SOFT, colSpan: 2 },
      {},
      { text: t.person, bold: true, fontSize: 8, fillColor: SOFT },
      ...PDF_NUTRIENTS.map((n) => ({ text: num(t[n.key], n.digits), bold: true, fontSize: 8, alignment: "right" as const, fillColor: SOFT })),
    ]);
  }
  return {
    unbreakable: true,
    margin: [0, 0, 0, 8],
    stack: [
      { text: label, bold: true, fontSize: 10, color: TEAL, margin: [0, 0, 0, 3], id: date },
      { table: { headerRows: 1, widths: [46, "*", 40, 62, ...PDF_NUTRIENTS.map(() => 33)], body: [header, ...body] }, layout: "lightHorizontalLines" },
    ],
  };
}

export async function buildPdf(plan: PlanExport): Promise<Buffer> {
  ensureFonts();
  const content: Content[] = [
    { text: plan.title, fontSize: 18, bold: true, color: TEAL },
    { text: `Generated ${plan.generatedOn}`, fontSize: 9, color: MUTED, margin: [0, 2, 0, 10] },
    {
      table: {
        headerRows: 1,
        widths: ["*", 90, 90, 90, 90, 90],
        body: [
          [th("Person", "left"), th("Protein target"), th("Avg protein/day"), th("% of target"), th("Avg energy/day"), th("Avg fibre/day")],
          ...plan.people.map((p) => {
            const a = plan.averages.find((x) => x.person === p.name);
            return [
              { text: p.name, fontSize: 9 },
              { text: `${p.proteinTargetG} g`, fontSize: 9, alignment: "right" as const },
              { text: a ? `${num(a.protein_g, 0)} g` : "-", fontSize: 9, alignment: "right" as const },
              { text: a ? `${a.proteinPct}%` : "-", fontSize: 9, alignment: "right" as const },
              { text: a ? `${num(a.kcal, 0)} kcal` : "-", fontSize: 9, alignment: "right" as const },
              { text: a ? `${num(a.fibre_g, 0)} g` : "-", fontSize: 9, alignment: "right" as const },
            ];
          }),
        ],
      },
      layout: "lightHorizontalLines",
    },
    { text: plan.notes.join(" "), fontSize: 8, color: MUTED, margin: [0, 8, 0, 0] },
  ];

  for (const w of plan.weeks) {
    content.push({ text: `${w.label}: ${w.from} to ${w.to}`, fontSize: 14, bold: true, color: TEAL, pageBreak: "before", margin: [0, 0, 0, 6] });
    const dates = [...new Set(plan.meals.filter((m) => m.week === w.n).map((m) => m.date))];
    for (const date of dates) {
      const meals = plan.meals.filter((m) => m.date === date);
      const totals = plan.days.filter((d) => d.date === date);
      content.push(dayTable(date, meals[0]!.day, meals, totals));
    }
  }

  // Groceries
  content.push({ text: "Grocery list", fontSize: 14, bold: true, color: TEAL, pageBreak: "before", margin: [0, 0, 0, 2] });
  content.push({ text: "Raw weights. To buy rounds up to whole packs where the pack size is known.", fontSize: 8, color: MUTED, margin: [0, 0, 0, 6] });
  const multi = plan.weeks.length > 1;
  const aisles = [...new Set(plan.grocery.map((g) => g.aisle))];
  for (const aisle of aisles) {
    const rows = plan.grocery.filter((g) => g.aisle === aisle);
    content.push({
      unbreakable: rows.length < 12,
      margin: [0, 0, 0, 8],
      stack: [
        { text: aisle, bold: true, fontSize: 10, margin: [0, 0, 0, 3] },
        {
          table: {
            headerRows: 1,
            widths: [10, "*", ...(multi ? plan.weeks.map(() => 46) : []), 52, 52, 40, 120],
            body: [
              [th("", "left"), th("Item", "left"), ...(multi ? plan.weeks.map((w) => th(`${w.label} g`)) : []), th("Need g"), th("Buy g"), th("Packs"), th("Where to buy", "left")],
              ...rows.map((g): TableCell[] => [
                { text: "[  ]", fontSize: 8, color: MUTED },
                { text: g.pantry ? `${g.item} (pantry)` : g.item, fontSize: 8.5 },
                ...(multi ? g.weekG.map((x): TableCell => ({ text: x ? num(x, 0) : "", fontSize: 8.5, alignment: "right" })) : []),
                { text: num(g.needG, 0), fontSize: 8.5, alignment: "right" },
                { text: num(g.buyG, 0), fontSize: 8.5, alignment: "right", bold: true },
                { text: g.packs ? String(g.packs) : "", fontSize: 8.5, alignment: "right" },
                { text: g.where, fontSize: 8, color: MUTED },
              ]),
            ],
          },
          layout: "lightHorizontalLines",
        },
      ],
    });
  }

  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageOrientation: "landscape",
    pageMargins: [28, 28, 28, 34],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    info: { title: plan.title, creator: "Protein Kitchen" },
    footer: (page, pages) => ({ text: `Protein Kitchen. Page ${page} of ${pages}`, alignment: "right", fontSize: 8, color: MUTED, margin: [0, 8, 28, 0] }),
    content,
  };
  return Buffer.from(await pdfmake.createPdf(doc).getBuffer());
}
