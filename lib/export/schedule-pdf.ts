import pdfmake from "pdfmake";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { ensureFonts } from "./pdf";
import type { ScheduleEntry, ScheduleModel, ScheduleWeek } from "./schedule-model";

/**
 * The fridge sheet: one A4 landscape page per plan week, black on white, no colour needed. Text is as large as the
 * page allows. If seven days of long names do not fit, the font steps down to 9 pt, then names are cut with an ellipsis.
 */

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = { left: 28, right: 28, top: 28, bottom: 36 };
const DAY_COL = 92;
const CELL_PAD_X = 5;
const CELL_PAD_Y = 3;
const LINE = 1.17;
/** Average Roboto glyph width as a share of the font size. Slightly generous so estimates err toward shrinking. */
const GLYPH = 0.56;
const INK = "#000000";
const BAND = "#eeeeee";
const HEAD = "#d4d4d4";

export interface FitLevel {
  fontSize: number;
  maxNameLines: number;
  maxPrepLines: number;
}

/** From largest to smallest. The last level always fits seven rows. */
export const FIT_LEVELS: readonly FitLevel[] = [
  { fontSize: 13, maxNameLines: 3, maxPrepLines: 3 },
  { fontSize: 12, maxNameLines: 3, maxPrepLines: 3 },
  { fontSize: 11, maxNameLines: 3, maxPrepLines: 3 },
  { fontSize: 10, maxNameLines: 3, maxPrepLines: 3 },
  { fontSize: 9, maxNameLines: 3, maxPrepLines: 2 },
  { fontSize: 9, maxNameLines: 2, maxPrepLines: 2 },
  { fontSize: 9, maxNameLines: 1, maxPrepLines: 1 },
];

const PREP_FONT = 9;
const smallFont = (fs: number) => Math.max(9, fs - 2);
const contentWidth = PAGE_W - MARGIN.left - MARGIN.right;
const slotWidth = (slots: number) => (contentWidth - DAY_COL) / slots;
const charsPerLine = (width: number, fs: number) => Math.max(4, Math.floor((width - 2 * CELL_PAD_X) / (GLYPH * fs)));
const linesFor = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));

/** Cuts to `max` characters on a word boundary where possible, ending with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface CellText {
  name: string;
  detail: string;
}

function cellTexts(e: ScheduleEntry, level: FitLevel, width: number): CellText {
  const perLine = charsPerLine(width, level.fontSize);
  const full = e.leftover ? `Leftovers: ${e.name}` : e.name;
  const small = charsPerLine(width, smallFont(level.fontSize));
  return {
    name: clip(full, perLine * level.maxNameLines),
    detail: clip(e.detail, small * (level.maxNameLines > 1 ? 2 : 1)),
  };
}

function cellHeight(entries: ScheduleEntry[] | undefined, level: FitLevel, width: number): number {
  const fs = level.fontSize;
  if (!entries?.length) return fs * LINE + 2 * CELL_PAD_Y;
  let h = 2 * CELL_PAD_Y;
  for (const e of entries) {
    const t = cellTexts(e, level, width);
    h += linesFor(t.name, charsPerLine(width, fs)) * fs * LINE;
    if (t.detail) h += linesFor(t.detail, charsPerLine(width, smallFont(fs))) * smallFont(fs) * LINE;
  }
  return h;
}

/** Fits the prep tasks into `maxLines`. Returns the runs to print and how many tasks were left out. */
export function fitPrep(week: ScheduleWeek, maxLines: number): { runs: { text: string; bold?: boolean }[]; left: number } {
  const budget = Math.floor(contentWidth / (GLYPH * PREP_FONT)) * maxLines - 30;
  const runs: { text: string; bold?: boolean }[] = [];
  let used = 0;
  let shown = 0;
  for (const p of week.prep) {
    const room = budget - used;
    const cost = p.dayLabel.length + p.text.length + 4;
    if (cost > room) {
      if (shown === 0 && room > 30) {
        runs.push({ text: `${p.dayLabel}: `, bold: true }, { text: clip(p.text, room - p.dayLabel.length - 2) });
        shown++;
      }
      break;
    }
    runs.push({ text: `${p.dayLabel}: `, bold: true }, { text: `${p.text}.   ` });
    used += cost;
    shown++;
  }
  return { runs, left: week.prep.length - shown };
}

function prepHeight(week: ScheduleWeek, level: FitLevel): number {
  if (week.prep.length === 0) return 0;
  const { runs, left } = fitPrep(week, level.maxPrepLines);
  const chars = runs.reduce((n, r) => n + r.text.length, 0) + (left > 0 ? 25 : 0);
  const lines = Math.min(level.maxPrepLines, linesFor("x".repeat(chars), Math.floor(contentWidth / (GLYPH * PREP_FONT))));
  return 8 + 11 + lines * PREP_FONT * LINE + 4;
}

const TITLE_BLOCK = 22 * LINE + 10;

/** Estimated height of a week at a level. Used to start near the right level; the real page count has the last word. */
export function estimateHeight(model: ScheduleModel, week: ScheduleWeek, level: FitLevel): number {
  const w = slotWidth(model.slots.length);
  const head = level.fontSize * LINE + 2 * CELL_PAD_Y + 2;
  const rows = week.days.reduce((sum, d) => {
    const cells = Math.max(...model.slots.map((s) => cellHeight(d.cells[s], level, w)));
    const dayCell = level.fontSize * LINE + smallFont(level.fontSize) * LINE + 2 * CELL_PAD_Y;
    return sum + Math.max(cells, dayCell) + 1;
  }, 0);
  return TITLE_BLOCK + head + rows + prepHeight(week, level);
}

const AVAILABLE = PAGE_H - MARGIN.top - MARGIN.bottom;

function entryContent(e: ScheduleEntry, level: FitLevel, width: number, last: boolean): Content {
  const t = cellTexts(e, level, width);
  const stack: Content[] = [{ text: t.name, fontSize: level.fontSize, bold: !e.leftover, italics: e.leftover, color: INK }];
  if (t.detail) stack.push({ text: t.detail, fontSize: smallFont(level.fontSize), color: INK });
  return { stack, margin: [0, 0, 0, last ? 0 : 2] };
}

function weekContent(model: ScheduleModel, week: ScheduleWeek, level: FitLevel, first: boolean, total: number): Content[] {
  const fs = level.fontSize;
  const w = slotWidth(model.slots.length);
  const th = (text: string): TableCell => ({ text, bold: true, fontSize: fs, color: INK, fillColor: HEAD, margin: [CELL_PAD_X, CELL_PAD_Y, CELL_PAD_X, CELL_PAD_Y] });
  const body: TableCell[][] = [[th("Day"), ...model.slots.map(th)]];
  week.days.forEach((d, i) => {
    const fill = i % 2 === 1 ? BAND : undefined;
    const row: TableCell[] = [
      { stack: [{ text: d.weekday, bold: true, fontSize: fs }, { text: d.dateLabel, fontSize: smallFont(fs) }], fillColor: fill, color: INK, margin: [CELL_PAD_X, CELL_PAD_Y, CELL_PAD_X, CELL_PAD_Y] },
    ];
    for (const slot of model.slots) {
      const entries = d.cells[slot];
      row.push(
        entries?.length
          ? { stack: entries.map((e, k) => entryContent(e, level, w, k === entries.length - 1)), fillColor: fill, margin: [CELL_PAD_X, CELL_PAD_Y, CELL_PAD_X, CELL_PAD_Y] }
          : { text: "-", fontSize: fs, color: INK, fillColor: fill, margin: [CELL_PAD_X, CELL_PAD_Y, CELL_PAD_X, CELL_PAD_Y] },
      );
    }
    body.push(row);
  });

  const out: Content[] = [
    {
      columns: [
        { text: week.title, fontSize: 22, bold: true, color: INK, width: "*" },
        { text: [{ text: `${model.audience}\n`, bold: true }, { text: total > 1 ? `Week ${week.n} of ${total}` : "Protein Kitchen" }], fontSize: 10, alignment: "right", color: INK, width: 230 },
      ],
      columnGap: 10,
      margin: [0, 0, 0, 8],
      ...(first ? {} : { pageBreak: "before" as const }),
    },
    {
      table: { headerRows: 1, widths: [DAY_COL, ...model.slots.map(() => "*" as const)], dontBreakRows: true, body },
      layout: {
        hLineWidth: () => 0.9,
        vLineWidth: () => 0.9,
        hLineColor: () => INK,
        vLineColor: () => INK,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
    },
  ];
  if (week.prep.length > 0) {
    const { runs, left } = fitPrep(week, level.maxPrepLines);
    out.push({
      margin: [0, 8, 0, 0],
      stack: [
        { text: "Prep ahead", bold: true, fontSize: 10 },
        { text: [...runs, ...(left > 0 ? [{ text: `+${left} more in the app`, italics: true }] : [])], fontSize: PREP_FONT, color: INK, margin: [0, 2, 0, 0] },
      ],
    });
  }
  return out;
}

export function scheduleDefinition(model: ScheduleModel, level: FitLevel): TDocumentDefinitions {
  const total = model.weeks.length;
  return {
    pageSize: "A4",
    pageOrientation: "landscape",
    pageMargins: [MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom],
    defaultStyle: { font: "Roboto", fontSize: level.fontSize, color: INK },
    info: { title: model.weeks.length === 1 ? model.weeks[0]!.title : "Weekly meal schedule", creator: "Protein Kitchen" },
    footer: () => ({ text: `Generated ${model.generatedOn}. Protein Kitchen`, alignment: "right", fontSize: 9, color: INK, margin: [0, 8, MARGIN.right, 0] }),
    content: model.weeks.flatMap((w, i) => weekContent(model, w, level, i === 0, total)),
  };
}

/** Counts page objects in PDF bytes. pdfkit writes each page as `/Type /Page`, the page tree as `/Type /Pages`. */
export function countPdfPages(pdf: Uint8Array): number {
  return (Buffer.from(pdf).toString("latin1").match(/\/Type \/Page(?![A-Za-z])/g) ?? []).length;
}

export async function buildSchedulePdf(model: ScheduleModel): Promise<Buffer> {
  ensureFonts();
  const firstFit = (w: ScheduleWeek) => {
    const i = FIT_LEVELS.findIndex((l) => estimateHeight(model, w, l) <= AVAILABLE);
    return i === -1 ? FIT_LEVELS.length - 1 : i;
  };
  // Start at the largest level where every week is estimated to fit, then trust the real page count.
  let start = Math.max(...model.weeks.map(firstFit));
  for (;;) {
    const level = FIT_LEVELS[start]!;
    const pdf = Buffer.from(await pdfmake.createPdf(scheduleDefinition(model, level)).getBuffer());
    if (countPdfPages(pdf) <= model.weeks.length || start === FIT_LEVELS.length - 1) return pdf;
    start++;
  }
}
