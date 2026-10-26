import { loadMigrationArtifacts, readSchemaShape, schemaResult } from "./check-production";
import type { MigrationArtifacts, Queryable } from "./check-production";
import { requireMigrationPrefix } from "../db/postgres/migration-ledger";
import type { LedgerRow } from "../db/postgres/migration-ledger";

/** One lock id for every migration runner (preview and production share the ledger discipline). */
export const MIGRATION_LOCK = { classId: 197548, objectId: 1 } as const;

export interface MigrationSession extends Queryable {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationLimits { lockTimeout: string; statementTimeout: string }
export const DEFAULT_LIMITS: MigrationLimits = { lockTimeout: "5s", statementTimeout: "120s" };

export interface MigrationRun {
  /** A single dedicated session: the advisory lock, the timeouts and the DDL must all share it. */
  session: MigrationSession;
  artifacts: Pick<MigrationArtifacts, "expected" | "snapshots">;
  /** Applies pending migrations on the same session. */
  apply: () => Promise<void>;
  limits?: MigrationLimits;
}

async function readLedger(session: MigrationSession): Promise<LedgerRow[]> {
  const exists = await session.query("select to_regclass('drizzle.__drizzle_migrations') as name");
  if (!exists.rows[0]?.name) return [];
  const { rows } = await session.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id");
  return rows.map((row) => ({ hash: String(row.hash), created_at: row.created_at as string | number | bigint }));
}

/**
 * Serialised, time-boxed migration: take the lock (bounded by lock_timeout), refuse a divergent ledger before any
 * write, apply, then require the exact ledger and the full schema shape of the last reviewed snapshot.
 * Session-level settings and the advisory lock die with the session; the caller destroys it afterwards.
 */
export async function runGuardedMigration(run: MigrationRun): Promise<{ applied: number }> {
  const { session, artifacts, apply } = run;
  const limits = run.limits ?? DEFAULT_LIMITS;
  if (!/^\d+(ms|s|min)$/.test(limits.lockTimeout) || !/^\d+(ms|s|min)$/.test(limits.statementTimeout)) {
    throw new Error("Invalid migration timeout.");
  }
  await session.query(`set lock_timeout = '${limits.lockTimeout}'`);
  await session.query(`set statement_timeout = '${limits.statementTimeout}'`);
  await session.query(`select pg_advisory_lock(${MIGRATION_LOCK.classId}, ${MIGRATION_LOCK.objectId})`);
  try {
    requireMigrationPrefix(await readLedger(session), artifacts.expected);
    await apply();
    requireMigrationPrefix(await readLedger(session), artifacts.expected, true);
    const expectedShape = artifacts.expected.length === 0 ? new Map() : artifacts.snapshots[artifacts.expected.length - 1];
    const schema = schemaResult(expectedShape, await readSchemaShape(session));
    if (schema.severity !== "ok") throw new Error(`Schema check after migration failed (${schema.code}).`);
    return { applied: artifacts.expected.length };
  } finally {
    await session.query(`select pg_advisory_unlock(${MIGRATION_LOCK.classId}, ${MIGRATION_LOCK.objectId})`).catch(() => undefined);
  }
}

export { loadMigrationArtifacts };
