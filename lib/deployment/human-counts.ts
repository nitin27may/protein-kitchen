/**
 * Row counts of the human-owned tables, read before and after a migration rehearsal. Counts only: no row, column
 * value or identifier derived from data is ever read, printed or stored.
 */
export interface CountQueryable {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Fixed identifiers (never user input), so they are safe to place in SQL text. One per line to merge cleanly. */
export const HUMAN_OWNED_TABLES = [
  "auth_users",
  "households",
  "household_members",
  "people",
  "preferences",
  "recipe_feedback",
  "person_recipe_feedback",
  "recipe_links",
  "photos",
  "photo_decisions",
  "household_foods",
  "food_log",
  "saved_views",
  "person_routines",
  "plan_routines",
  "plan_setups",
  "plans",
  "plan_slots",
  "plan_slot_portions",
  "habit_log",
  "prep_task_state",
  "grocery_state",
  "grocery_manual",
  "plan_part_state",
  "plan_progress",
  "pantry",
] as const;

/** `null` means the table does not exist (yet). */
export type TableCounts = Record<string, number | null>;

export async function readHumanCounts(q: CountQueryable, tables: readonly string[] = HUMAN_OWNED_TABLES): Promise<TableCounts> {
  const counts: TableCounts = {};
  await q.query("begin read only");
  try {
    for (const table of tables) {
      const exists = await q.query(`select to_regclass('public.${table}') is not null as present`);
      if (!exists.rows[0]?.present) { counts[table] = null; continue; }
      const { rows } = await q.query(`select count(*)::text as n from public.${table}`);
      const n = Number(rows[0]?.n);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("COUNTS_INVALID: a row count was not a number.");
      counts[table] = n;
    }
  } finally {
    await q.query("rollback");
  }
  return counts;
}

export interface CountComparison { ok: boolean; lost: string[]; dropped: string[] }

/** A table lost rows if its count fell, or if it existed before and no longer exists. New tables are fine. */
export function compareHumanCounts(before: TableCounts, after: TableCounts): CountComparison {
  const lost: string[] = [], dropped: string[] = [];
  for (const [table, was] of Object.entries(before)) {
    if (was === null) continue;
    const now = after[table];
    if (now === undefined || now === null) dropped.push(table);
    else if (now < was) lost.push(table);
  }
  return { ok: lost.length + dropped.length === 0, lost, dropped };
}

export function parseCounts(json: unknown): TableCounts {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("COUNTS_INVALID: counts file is malformed.");
  const out: TableCounts = {};
  for (const [table, value] of Object.entries(json)) {
    if (!/^[a-z_]+$/.test(table) || !(value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0))) {
      throw new Error("COUNTS_INVALID: counts file is malformed.");
    }
    out[table] = value;
  }
  return out;
}
