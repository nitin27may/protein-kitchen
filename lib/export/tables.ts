import { NUTRIENT_COLS, type PlanExport } from "./model";

/** Plain table description shared by on-screen sheets. Keeps the spreadsheet component free of plan logic. */
export type CellFmt = "text" | "int" | "d1" | "d2" | "pct";

export interface SheetColumn {
  header: string;
  width: number;
  fmt: CellFmt;
  bold?: boolean;
}

export interface SheetTable {
  name: string;
  columns: SheetColumn[];
  rows: (string | number | null)[][];
  /** Columns kept in view while scrolling sideways. */
  freezeCols: number;
  /** Rows drawn in bold with a tint, for averages and totals. */
  emphasisRows: number[];
  /** A thicker rule is drawn above each row where this column's value changes (the day, the aisle). */
  groupCol?: number;
  /** Column holding a 0-1 ratio that is coloured red under 0.9 and green at or above. */
  ratioCol?: number;
}

const fmtOf = (digits: number): CellFmt => (digits === 0 ? "int" : digits === 1 ? "d1" : "d2");
const head = (c: { header: string; unit: string }) => `${c.header} (${c.unit})`;

export function buildTables(plan: PlanExport): SheetTable[] {
  const tables: SheetTable[] = [];

  tables.push({
    name: "Summary",
    freezeCols: 1,
    emphasisRows: [],
    columns: [
      { header: "Person", width: 120, fmt: "text", bold: true },
      { header: "Protein target (g)", width: 130, fmt: "int" },
      { header: "Avg protein (g/day)", width: 140, fmt: "d1" },
      { header: "Avg % of target", width: 120, fmt: "pct" },
      { header: "Energy target (kcal)", width: 140, fmt: "int" },
      { header: "Avg energy (kcal/day)", width: 150, fmt: "int" },
      { header: "Avg fibre (g/day)", width: 130, fmt: "d1" },
      { header: "Avg free sugars (g/day)", width: 160, fmt: "d1" },
      { header: "Avg sodium (mg/day)", width: 140, fmt: "int" },
    ],
    ratioCol: 3,
    rows: plan.people.map((p) => {
      const a = plan.averages.find((x) => x.person === p.name);
      return [p.name, p.proteinTargetG, a?.protein_g ?? 0, (a?.proteinPct ?? 0) / 100, p.kcalTarget, a?.kcal ?? 0, a?.fibre_g ?? 0, a?.freeSugar_g ?? 0, a?.sodium_mg ?? 0];
    }),
  });

  const mealCols: SheetColumn[] = [
    { header: "Day", width: 110, fmt: "text" },
    { header: "Meal", width: 90, fmt: "text" },
    { header: "Recipe", width: 250, fmt: "text" },
    { header: "Person", width: 100, fmt: "text" },
    { header: "Portion", width: 140, fmt: "text", bold: true },
    { header: "Servings", width: 90, fmt: "d2" },
    { header: "Weight (g)", width: 100, fmt: "int" },
    ...NUTRIENT_COLS.map((c): SheetColumn => ({ header: head(c), width: 112, fmt: fmtOf(c.digits) })),
    { header: "Note", width: 200, fmt: "text" },
  ];
  for (const w of plan.weeks) {
    const rows = plan.meals.filter((m) => m.week === w.n);
    tables.push({
      name: w.label,
      columns: mealCols,
      freezeCols: 4,
      emphasisRows: [],
      groupCol: 0,
      rows: rows.map((r) => [
        r.day, r.slot, r.leftover ? `${r.recipe} (leftover)` : r.recipe, r.person, r.portion, r.servings, r.weightG,
        ...NUTRIENT_COLS.map((c) => r[c.key]),
        r.partial ? "Micros are lower bounds" : "",
      ]),
    });
  }

  const all = [...plan.days, ...plan.averages];
  tables.push({
    name: "Daily totals",
    freezeCols: 2,
    emphasisRows: plan.averages.map((_, i) => plan.days.length + i),
    groupCol: 0,
    ratioCol: 3 + NUTRIENT_COLS.length + 1,
    columns: [
      { header: "Day", width: 130, fmt: "text" },
      { header: "Person", width: 100, fmt: "text" },
      { header: "Meals", width: 70, fmt: "d1" },
      ...NUTRIENT_COLS.map((c): SheetColumn => ({ header: head(c), width: 112, fmt: fmtOf(c.digits) })),
      { header: "Protein target (g)", width: 130, fmt: "int" },
      { header: "Protein % of target", width: 140, fmt: "pct", bold: true },
      { header: "Energy target (kcal)", width: 140, fmt: "int" },
    ],
    rows: all.map((r) => [r.day, r.person, r.meals, ...NUTRIENT_COLS.map((c) => r[c.key]), r.proteinTargetG, r.proteinPct / 100, r.kcalTarget]),
  });

  const multi = plan.weeks.length > 1;
  tables.push({
    name: "Groceries",
    freezeCols: 2,
    emphasisRows: [],
    groupCol: 0,
    columns: [
      { header: "Aisle", width: 130, fmt: "text" },
      { header: "Item", width: 230, fmt: "text", bold: true },
      { header: "State", width: 80, fmt: "text" },
      ...(multi ? plan.weeks.map((w): SheetColumn => ({ header: `${w.label} (g)`, width: 100, fmt: "int" })) : []),
      { header: "Total needed (g)", width: 130, fmt: "int" },
      { header: "To buy (g)", width: 100, fmt: "int", bold: true },
      { header: "Packs", width: 70, fmt: "int" },
      { header: "Pack size (g)", width: 110, fmt: "int" },
      { header: "Pantry staple", width: 110, fmt: "text" },
      { header: "Where to buy", width: 200, fmt: "text" },
      { header: "Used in", width: 420, fmt: "text" },
    ],
    rows: plan.grocery.map((g) => [g.aisle, g.item, g.state, ...(multi ? g.weekG : []), g.needG, g.buyG, g.packs, g.packSizeG, g.pantry ? "Yes" : "", g.where, g.usedIn]),
  });

  return tables;
}
