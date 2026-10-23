import fs from "node:fs";
import path from "node:path";
import { count as countRows, eq, isNotNull, or } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import type { Tx } from "../db/tx";
import { markChanged, nowIso } from "../human/util";

export const RESET_SCOPES = ["plans", "groceries", "progress", "ratings", "profiles", "all"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

/** Scopes that wipe people. They need the typed word, not just a click. */
export const NEEDS_TYPED_CONFIRM: readonly ResetScope[] = ["profiles", "all"];
export const CONFIRM_WORD = "RESET";

export interface ResetCounts {
  profiles: number;
  plans: number;
  groceryItems: number;
  progressTicks: number;
  ratings: number;
  /** Make, buy or have choices saved on plans. They go with the plans. */
  partChoices: number;
}

// Drizzle's count() is a bigint on Postgres, so every result goes through Number().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function count(db: Db, table: any): Promise<number> {
  const [row] = await db.select({ n: countRows() }).from(table);
  return Number(row?.n ?? 0);
}

export async function resetCounts(db: Db): Promise<ResetCounts> {
  const [feedback] = await db
    .select({ n: countRows() })
    .from(s.recipeFeedback)
    .where(or(isNotNull(s.recipeFeedback.rating), eq(s.recipeFeedback.favourite, true), eq(s.recipeFeedback.banned, true), eq(s.recipeFeedback.status, "tested"), isNotNull(s.recipeFeedback.notes)));
  return {
    profiles: await count(db, s.people),
    plans: await count(db, s.plans),
    groceryItems: (await count(db, s.groceryState)) + (await count(db, s.groceryManual)) + (await count(db, s.pantry)),
    progressTicks: (await count(db, s.habitLog)) + (await count(db, s.prepTaskState)),
    ratings: Number(feedback?.n ?? 0),
    partChoices: await count(db, s.planPartState),
  };
}

function clearPlans(tx: Tx) {
  tx.delete(s.planPartState).run();
  tx.delete(s.planSlotPortions).run();
  tx.delete(s.groceryState).run();
  tx.delete(s.groceryManual).run();
  tx.delete(s.planSlots).run();
  tx.delete(s.plans).run();
  tx.delete(s.planSetups).run();
  tx.delete(s.prepTaskState).run();
}

function clearGroceries(tx: Tx) {
  tx.delete(s.groceryState).run();
  tx.delete(s.groceryManual).run();
  tx.delete(s.pantry).run();
}

function clearProgress(tx: Tx) {
  tx.delete(s.habitLog).run();
  tx.delete(s.reminderLog).run();
  tx.delete(s.prepTaskState).run();
}

function clearRatings(tx: Tx) {
  tx.update(s.recipeFeedback).set({ status: "draft", rating: null, favourite: false, banned: false, notes: null, testedAt: null }).run();
  markChanged(tx, "recipe-feedback", nowIso());
}

function clearProfiles(tx: Tx) {
  clearPlans(tx);
  clearProgress(tx);
  tx.delete(s.pushSubscriptions).run();
  tx.delete(s.preferences).run();
  tx.delete(s.people).run();
}

/**
 * Deletes user data only. Recipes, ingredients, techniques and habits come from /data and are never touched.
 * Runs in one transaction, so a failure leaves everything as it was.
 */
export async function resetData(db: Db, scope: ResetScope): Promise<void> {
  await withTx(db, (tx) => {
    switch (scope) {
      case "plans": return clearPlans(tx);
      case "groceries": return clearGroceries(tx);
      case "progress": return clearProgress(tx);
      case "ratings": return clearRatings(tx);
      case "profiles": return clearProfiles(tx);
      case "all":
        clearProfiles(tx);
        clearGroceries(tx);
        clearRatings(tx);
        tx.delete(s.savedViews).run();
        markChanged(tx, "saved-views", nowIso());
        return;
    }
  });
}

/** Copies the live database to backups/ before a reset. Returns the path, or null for an in-memory database. */
export async function backupBeforeReset(sqlite: Database.Database, root: string, scope: ResetScope): Promise<string | null> {
  if (sqlite.name === ":memory:" || sqlite.memory) return null;
  const dir = path.join(root, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `pre-reset-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  sqlite.prepare("VACUUM INTO ?").run(out);
  return out;
}
