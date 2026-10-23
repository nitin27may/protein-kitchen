"use client";

import { useEffect, useRef, useState } from "react";
import { createUniver, defaultTheme, LocaleType, merge, type IWorkbookData, type IStyleData } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import sheetsFilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import sheetsSortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import { SheetToolbar } from "./SheetToolbar";
import type { PlanExport } from "@/lib/export/model";
import { buildTables, type CellFmt, type SheetTable } from "@/lib/export/tables";

const HEAD_BG = "#0f6b7a";
const TINT = "#dcf0f3";
const RULE = "#6f7f88";

const PATTERN: Record<CellFmt, string | undefined> = { text: undefined, int: "#,##0", d1: "#,##0.0", d2: "#,##0.00", pct: "0%" };

/** Univer style ids are strings; build them once per distinct look. */
function styleBook() {
  const styles: Record<string, IStyleData> = {};
  const ids = new Map<string, string>();
  const key = (s: IStyleData): string => {
    const json = JSON.stringify(s);
    const hit = ids.get(json);
    if (hit) return hit;
    const id = `s${ids.size}`;
    ids.set(json, id);
    styles[id] = s;
    return id;
  };
  return { styles, key };
}

function toWorkbook(tables: SheetTable[]): IWorkbookData {
  const { styles, key } = styleBook();
  const header = key({ bg: { rgb: HEAD_BG }, cl: { rgb: "#ffffff" }, bl: 1, ht: 2, vt: 2, tb: 3, fs: 11 });
  const sheets: IWorkbookData["sheets"] = {};
  const sheetOrder: string[] = [];

  tables.forEach((t, si) => {
    const id = `sheet-${si}`;
    sheetOrder.push(id);
    const cellData: Record<number, Record<number, { v?: string | number; s?: string }>> = {};
    cellData[0] = Object.fromEntries(t.columns.map((c, ci) => [ci, { v: c.header, s: header }]));
    t.rows.forEach((row, ri) => {
      const r = ri + 1;
      const emphasis = t.emphasisRows.includes(ri);
      const newGroup = t.groupCol !== undefined && ri > 0 && t.rows[ri - 1]![t.groupCol] !== row[t.groupCol];
      cellData[r] = {};
      row.forEach((value, ci) => {
        const col = t.columns[ci]!;
        if (value === null || value === "") return;
        const style: IStyleData = { vt: 2, fs: 11 };
        if (col.fmt !== "text") {
          style.ht = 3;
          style.n = { pattern: PATTERN[col.fmt]! };
        }
        if (col.bold || emphasis) style.bl = 1;
        if (emphasis) style.bg = { rgb: TINT };
        if (emphasis) style.cl = { rgb: "#0b2f36" };
        if (ci === t.ratioCol && typeof value === "number") style.cl = { rgb: value < 0.9 ? "#c0392b" : "#1f7a4d" };
        if (newGroup) style.bd = { t: { s: 1, cl: { rgb: RULE } } };
        cellData[r]![ci] = { v: value, s: key(style) };
      });
    });
    sheets[id] = {
      id,
      name: t.name,
      rowCount: Math.max(t.rows.length + 40, 100),
      columnCount: Math.max(t.columns.length + 6, 26),
      defaultRowHeight: 26,
      rowData: { 0: { h: 44 } },
      columnData: Object.fromEntries(t.columns.map((c, ci) => [ci, { w: c.width }])),
      freeze: { xSplit: t.freezeCols, ySplit: 1, startColumn: t.freezeCols, startRow: 1 },
      showGridlines: 1,
      cellData,
    } as IWorkbookData["sheets"][string];
  });

  return { id: "meal-plan", name: "Meal plan", appVersion: "1.0.0", locale: LocaleType.EN_US, styles, sheetOrder, sheets };
}

function resolvedDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function SheetView({ planId, plan }: { planId: number; plan: PlanExport }) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  // Native fullscreen where the browser allows it; otherwise the fixed overlay below still fills the window.
  async function toggleFull() {
    if (!full) {
      setFull(true);
      try {
        await shell.current?.requestFullscreen?.();
      } catch {
        /* the overlay alone is fine */
      }
    } else {
      setFull(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    try {
      const { univerAPI } = createUniver({
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: merge({}, sheetsCoreEnUS, sheetsFilterEnUS, sheetsSortEnUS) },
        theme: defaultTheme,
        darkMode: resolvedDark(),
        presets: [
          UniverSheetsCorePreset({ container: el, formulaBar: true, header: true, toolbar: true }),
          UniverSheetsFilterPreset(),
          UniverSheetsSortPreset(),
        ],
      });
      const workbook = univerAPI.createWorkbook(toWorkbook(buildTables(plan)));
      // Every sheet gets a filter row, so sort and filter are one click on any header.
      queueMicrotask(() => {
        if (disposed) return;
        for (const sheet of workbook.getSheets()) {
          const rows = sheet.getLastRow() + 1;
          const cols = sheet.getLastColumn() + 1;
          if (rows > 1 && cols > 0) sheet.getRange(0, 0, rows, cols).createFilter();
        }
        // Open on the first week; Summary stays one tab to the left.
        const first = workbook.getSheets().find((sh) => sh.getSheetName().startsWith("Week")) ?? workbook.getSheets()[0];
        if (first) workbook.setActiveSheet(first);
      });
      const sync = () => univerAPI.toggleDarkMode(resolvedDark());
      const obs = new MutationObserver(sync);
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", sync);
      cleanup = () => {
        obs.disconnect();
        mq.removeEventListener("change", sync);
        univerAPI.dispose();
      };
    } catch (e) {
      console.error("[sheet] failed to start", e);
      setError("The spreadsheet could not start. Use Download Excel instead.");
    }
    return () => {
      disposed = true;
      cleanup();
    };
  }, [plan]);

  return (
    <div ref={shell} data-full={full ? "" : undefined} className={full ? "fixed inset-0 z-50 overflow-auto bg-bg px-3 pb-2 pt-2" : "px-4 pt-3 lg:px-0"}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-muted">{plan.weeks.length} {plan.weeks.length === 1 ? "week" : "weeks"}, daily totals and groceries. Filter and sort from the headers.</p>
        <SheetToolbar planId={planId} full={full} onToggleFull={toggleFull} />
      </div>
      {error ? <p role="alert" className="rounded-card border border-line bg-badsoft p-3 text-sm text-bad">{error}</p> : null}
      <div ref={host} className="sheet-host overflow-hidden rounded-card border border-strong" />
      <p className="mt-2 text-xs text-muted">Micronutrients are lower bounds where a source did not report an ingredient. Missing values are never counted as zero.</p>
    </div>
  );
}
