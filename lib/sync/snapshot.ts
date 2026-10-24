import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { exportHumanData, type ExportBundle } from "../human/export";
import { nowIso } from "../human/util";

export const STATE_SYNC_CLASSES = ["recipe-feedback", "recipe-links", "saved-views", "photos", "photo-decisions"] as const;

export interface StateSnapshot {
  bundle: ExportBundle;
  revisions: Record<string, number>;
}

export function selectedStateClasses(names: readonly string[]): string[] {
  if (!names.length || new Set(names).size !== names.length ||
      names.some((name) => !STATE_SYNC_CLASSES.some((allowed) => name === allowed))) {
    throw new Error("State sync requires an explicit, unique selection of permitted shared data classes.");
  }
  return [...names].sort();
}

/** No blob/network I/O: files and their receipts must describe the same database snapshot. */
export async function captureStateSnapshot(db: Db, names: readonly string[]): Promise<StateSnapshot> {
  const selected = selectedStateClasses(names);
  return db.transaction(async (tx) => {
    for (const dataClass of selected) {
      await tx.insert(s.syncState).values({ dataClass, changedAt: nowIso() }).onConflictDoNothing();
    }
    const rows = await tx.select().from(s.syncState).where(inArray(s.syncState.dataClass, selected)).orderBy(s.syncState.dataClass);
    const bundle = await exportHumanData(tx, selected);
    return { bundle, revisions: Object.fromEntries(rows.map((row) => [row.dataClass, row.revision])) };
  }, { isolationLevel: "repeatable read" });
}

/** Call only after verified remote success; stale receipts leave newer writes pending. */
export async function acknowledgeStateSnapshot(db: Db, revisions: Readonly<Record<string, number>>): Promise<string[]> {
  const selected = selectedStateClasses(Object.keys(revisions));
  if (selected.some((name) => !Number.isSafeInteger(revisions[name]) || revisions[name]! < 1)) {
    throw new Error("State sync receipts require positive integer revisions.");
  }
  const at = nowIso();
  return db.transaction(async (tx) => {
    const acknowledged: string[] = [];
    for (const dataClass of selected) {
      const revision = revisions[dataClass]!;
      const rows = await tx.update(s.syncState).set({ exportedRevision: revision, exportedAt: at })
        .where(and(eq(s.syncState.dataClass, dataClass), eq(s.syncState.revision, revision), lt(s.syncState.exportedRevision, revision)))
        .returning({ name: s.syncState.dataClass });
      if (rows.length) acknowledged.push(dataClass);
    }
    return acknowledged;
  });
}

export async function readStateSyncStatus(db: Db, names: readonly string[]) {
  const selected = selectedStateClasses(names);
  const rows = await db.select().from(s.syncState).where(inArray(s.syncState.dataClass, selected));
  return selected.map((dataClass) => {
    const row = rows.find((candidate) => candidate.dataClass === dataClass);
    return {
      dataClass, revision: row?.revision ?? 0, exportedRevision: row?.exportedRevision ?? 0,
      changedAt: row?.changedAt ?? null,
      pending: !row || row.revision > row.exportedRevision,
    };
  });
}
