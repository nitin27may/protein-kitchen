import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTableName } from "drizzle-orm";
import { readEncryptedBackup, recoveryTool, RecoveryError } from "../backup/read";
import { postgresEnvironment } from "../backup/process";
import { openPostgres } from "../db/postgres/client";
import { validatePostgresTarget, type PostgresTarget } from "../db/postgres/target";
import * as s from "../db/schema";

export interface PostgresRecoveryOptions {
  target: PostgresTarget;
  artifact: string;
  identity: string;
  photoDirectory: string;
  trusted: boolean;
  ageBinary?: string;
  restoreBinary?: string;
}

export function isolatedRestoreTarget(target: PostgresTarget) {
  const url = validatePostgresTarget(target);
  postgresEnvironment(target);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/protein_kitchen_restore_[0-9a-f]{32}$/.test(url.pathname)) throw new RecoveryError("destination-refused");
  return url.pathname.slice(1);
}

/** Explicit trusted local recovery, never an application mutation or a production reset. */
export async function restoreEncryptedPostgres(options: PostgresRecoveryOptions) {
  const database = isolatedRestoreTarget(options.target);
  const artifact = await readEncryptedBackup(options.artifact, options.identity, options.trusted, options.ageBinary);
  const destination = path.resolve(options.photoDirectory);
  const staging = path.join(path.dirname(destination), `.pending-restore-${randomUUID()}`);
  const handle = openPostgres(options.target);
  let reserved = false, staged = false, restored = false;
  try {
    const existing = await handle.pool.query("SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND (EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid) OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid) OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid)) LIMIT 1");
    const schemas = await handle.pool.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'public') LIMIT 1");
    if (existing.rowCount || schemas.rowCount) throw new RecoveryError("destination-refused");
    await mkdir(destination, { mode: 0o700 }); reserved = true;
    await mkdir(staging, { mode: 0o700 }); staged = true;
    for (const object of artifact.contents) {
      const file = path.join(staging, object.key);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, object.bytes, { flag: "wx", mode: 0o600, flush: true });
    }
    try {
      await recoveryTool(options.restoreBinary ?? "pg_restore", [
        "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", "--dbname", database,
      ], artifact.dump, 0, { ...postgresEnvironment(options.target), PGAPPNAME: "protein-kitchen-restore" });
      restored = true;
    } catch { throw new RecoveryError("restore-failed"); }
    const tables = await handle.pool.query<{ tablename: string }>("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const expected = Object.values(s).map(getTableName).sort();
    const photos = await handle.db.select({ uid: s.photos.uid, sha256: s.photos.sha256 }).from(s.photos);
    if (JSON.stringify(tables.rows.map((row) => row.tablename)) !== JSON.stringify(expected) ||
        photos.length !== artifact.photos.size || photos.some((row) => artifact.photos.get(row.uid) !== row.sha256)) {
      throw new RecoveryError("verification-failed");
    }
    await rename(staging, destination); staged = false; reserved = false;
    return { id: artifact.id, tables: expected.length, photos: photos.length };
  } catch (error) {
    try {
      if (staged) await rm(staging, { recursive: true });
      if (reserved) await rmdir(destination);
    } catch { throw new RecoveryError("cleanup-failed"); }
    throw error instanceof RecoveryError ? error : new RecoveryError(restored ? "verification-failed" : "destination-refused");
  } finally { await handle.close(); }
}
