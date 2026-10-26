import { and, eq, gte, lt, count } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { Tx } from "../db/tx";
import { nowIso } from "../human/util";

/**
 * Operational log of label-reading model calls, used for cost caps. Not human-owned: never exported, never marked in
 * sync_state, not touched by a household reset (a reset must not clear the cost counter), deleted with the household,
 * and pruned after 90 days. No label text or image is stored here, only counts.
 */
export const LABEL_EXTRACTION_RETENTION_DAYS = 90;
export type LabelExtractionOutcome = (typeof s.labelExtractions.$inferInsert)["outcome"];

export interface LabelExtractionRecord {
  householdId: string;
  personId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  outcome: LabelExtractionOutcome;
}

export async function recordLabelExtraction(db: Db, record: LabelExtractionRecord, at: string = nowIso()): Promise<void> {
  await db.insert(s.labelExtractions).values({
    ...record, inputTokens: Math.max(0, Math.trunc(record.inputTokens)), outputTokens: Math.max(0, Math.trunc(record.outputTokens)), createdAt: at,
  });
}

/** Calls made by a household since `since` (ISO), for a daily or monthly cap. */
export async function countLabelExtractions(db: Db, householdId: string, since: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(s.labelExtractions)
    .where(and(eq(s.labelExtractions.householdId, householdId), gte(s.labelExtractions.createdAt, since)));
  return Number(row?.n ?? 0);
}

/** Deletes rows older than the retention window. Returns how many went. */
export async function pruneLabelExtractions(db: Db, now: Date = new Date(), days: number = LABEL_EXTRACTION_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const gone = await db.delete(s.labelExtractions).where(lt(s.labelExtractions.createdAt, cutoff)).returning({ id: s.labelExtractions.id });
  return gone.length;
}

/** Household deletion, in the caller's transaction. */
export async function deleteLabelExtractionsForHousehold(tx: Tx, householdId: string): Promise<void> {
  await tx.delete(s.labelExtractions).where(eq(s.labelExtractions.householdId, householdId));
}
