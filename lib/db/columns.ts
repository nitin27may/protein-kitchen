import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * Portable column helpers. Every table adds columns only through these, so the move to Postgres is a change
 * in this one file plus the table builder import, not in every table.
 *
 *   helper        SQLite today                 Postgres later
 *   json<T>       text, JSON-encoded           jsonb
 *   bool          integer 0/1                  boolean
 *   isoDate       text 'YYYY-MM-DD'            date (string mode)
 *   isoTimestamp  text ISO-8601 UTC            timestamptz (string mode)
 *
 * Rules that keep SQL portable: dates are 'YYYY-MM-DD', timestamps are ISO-8601 UTC strings produced with
 * `new Date().toISOString()`; no strftime or json_extract in app queries; no reliance on rowid; give every
 * foreign key an explicit onDelete; enums are TypeScript unions validated with Zod.
 */
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
export const bool = (name: string) => integer(name, { mode: "boolean" });
export const isoDate = (name: string) => text(name);
export const isoTimestamp = (name: string) => text(name);
