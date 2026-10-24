import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as postgres from "./schema";
import * as legacy from "./sqlite-schema";
import { sha256, stableJson } from "../human/util";

export type ImportRow = Record<string, unknown>;
export interface TableDigest { count: number; sha256: string }
export interface SqliteSnapshot {
  rows: Record<string, ImportRow[]>;
  tables: Record<string, TableDigest>;
}

/** Only legacy tables participate; library_state must be set by an explicit content seed after import. */
const legacyNames = new Set<string>(Object.values(legacy).map(getTableName));
export const importTables = Object.values(postgres).filter((table) => legacyNames.has(getTableName(table)));

export function digestRows(rows: readonly ImportRow[]): TableDigest {
  return { count: rows.length, sha256: sha256(rows.map(stableJson).sort().join("\u0000")) };
}

export function normalizeImportValue(column: PgColumn, value: unknown): unknown {
  const invalid = () => new Error(`SQLite import cannot normalize ${getTableName(column.table)}.${column.name}.`);
  if (value === null) {
    if (column.notNull) throw invalid();
    return null;
  }
  if (column.dataType === "boolean") {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    throw invalid();
  }
  if (column.dataType === "json") {
    if (typeof value !== "string") throw invalid();
    try {
      const parsed: unknown = JSON.parse(value, (_key: string, item: unknown) => {
        if (typeof item === "number" && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) throw invalid();
        return item;
      });
      // SQL NULL and a JSON null cannot be represented distinctly by the application contract.
      if (parsed === null) throw invalid();
      return parsed;
    } catch { throw invalid(); }
  }
  if (column.dataType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
    if (column.columnType === "PgInteger" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw invalid();
    return value;
  }
  if (typeof value !== "string" || value.includes("\0")) throw invalid();
  if (column.getSQLType() === "timestamp with time zone") {
    // SQLite has historically stored both date-only and explicit-offset ISO timestamps. Never use local time.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
    const date = normalized.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(normalized) ||
        !Number.isFinite(Date.parse(normalized)) || new Date(date).toISOString().slice(0, 10) !== date) throw invalid();
    return new Date(normalized).toISOString();
  }
  if (column.getSQLType() === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw invalid();
  return value;
}

export function readSqliteSnapshot(file: string): SqliteSnapshot {
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    return source.transaction(() => {
      const integrity = source.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("SQLite source failed integrity_check.");
      const broken = source.pragma("foreign_key_check") as unknown[];
      if (broken.length) throw new Error("SQLite source contains broken foreign keys.");
      const expected = new Set<string>(importTables.map(getTableName));
      const actual = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND name <> '__drizzle_migrations'").all() as { name: string }[];
      if (actual.length !== expected.size || actual.some(({ name }) => !expected.has(name))) {
        throw new Error("SQLite source tables do not match the supported legacy schema. Migrate a private copy first.");
      }
      const result: SqliteSnapshot = { rows: {}, tables: {} };
      for (const table of importTables) {
        const { name, columns } = getTableConfig(table);
        const actualColumns = source.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
        if (actualColumns.length !== columns.length || actualColumns.some((c) => !columns.some((expected) => expected.name === c.name))) {
          throw new Error(`SQLite source columns do not match ${name}. Migrate a private copy first.`);
        }
        const rows = source.prepare(`SELECT * FROM "${name}"`).all() as ImportRow[];
        result.rows[name] = rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, normalizeImportValue(column, row[column.name])])));
        result.tables[name] = digestRows(result.rows[name]!);
      }
      return result;
    })();
  } finally {
    source.close();
  }
}
