import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../db/client";
import * as s from "../db/schema";

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const count = (db: Db, table: any): number =>
  db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;

export function resetCounts(db: Db): ResetCounts {
  return {
    profiles: count(db, s.people),
    plans: count(db, s.plans),
    groceryItems: count(db, s.groceryState) + count(db, s.groceryManual) + count(db, s.pantry),
    progressTicks: count(db, s.habitLog) + count(db, s.prepTaskState),
    ratings:
      db
        .select({ n: sql<number>`count(*)` })
        .from(s.recipeFeedback)
        .where(sql`${s.recipeFeedback.rating} is not null or ${s.recipeFeedback.favourite} = 1 or ${s.recipeFeedback.banned} = 1 or ${s.recipeFeedback.status} = 'tested' or ${s.recipeFeedback.notes} is not null`)
        .get()?.n ?? 0,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function clearPlans(tx: Tx) {
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
export function resetData(db: Db, scope: ResetScope): void {
  db.transaction((tx) => {
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
        return;
    }
  });
}

/** Copies the live database to backups/ before a reset. Returns the path, or null for an in-memory database. */
export function backupBeforeReset(sqlite: Database.Database, root: string, scope: ResetScope): string | null {
  if (sqlite.name === ":memory:" || sqlite.memory) return null;
  const dir = path.join(root, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `pre-reset-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  sqlite.prepare("VACUUM INTO ?").run(out);
  return out;
}
