import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import * as s from "../db/schema";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const newUid = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** JSON with sorted keys, 2-space indent and a trailing newline, so the same data always gives the same bytes. */
export const stableJson = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Marks a data class as changed since its last export. Called inside the same transaction as the write.
 * Awaited in the same Postgres transaction as the corresponding human-owned write.
 */
export async function markChanged(tx: Tx, dataClass: string, at: string): Promise<void> {
  await tx.insert(s.syncState).values({ dataClass, changedAt: at }).onConflictDoUpdate({ target: s.syncState.dataClass, set: { changedAt: at } });
}

/** Stamps `exported_at` for the given data classes. Called by the sync job after a successful export. */
export async function markExported(db: Db, dataClasses: string[], at: string = nowIso()): Promise<void> {
  for (const dataClass of dataClasses) {
    await db.insert(s.syncState).values({ dataClass, changedAt: at, exportedAt: at }).onConflictDoUpdate({ target: s.syncState.dataClass, set: { exportedAt: at } });
  }
}
