import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { previewPreflight } from "../lib/deployment/preflight";
import { previewLibraryTables, previewMigrationTarget, requireMigrationPrefix } from "../lib/deployment/preview-migration";

const env = process.env;
const target = previewMigrationTarget(env);
const report = await previewPreflight(env, true);
if (!report.configurationValid || !report.liveBranchVerified) {
  throw new Error(`Preview migration preflight refused: ${report.failed.join(", ")}.`);
}
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/postgres-migrations");
const expected = readMigrationFiles({ migrationsFolder: folder });
const handle = await openVerifiedPostgres(target, env);
try {
  const client = await handle.pool.connect();
  try {
    await client.query("select pg_advisory_lock(197548, 1)");
    const ledger = async () => {
      const exists = await client.query("select to_regclass('drizzle.__drizzle_migrations') as name");
      return exists.rows[0].name
        ? (await client.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id")).rows
        : [];
    };
    requireMigrationPrefix(await ledger(), expected);
    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    for (const { tablename } of tables.rows) {
      if (previewLibraryTables.has(tablename)) continue;
      const quoted = `"${tablename.replaceAll('"', '""')}"`;
      const result = await client.query(`select exists(select 1 from public.${quoted} limit 1) as occupied`);
      if (result.rows[0].occupied) throw new Error("Preview migration refuses a target containing non-library state.");
    }
    await migrate(drizzle(client), { migrationsFolder: folder });
    requireMigrationPrefix(await ledger(), expected, true);
    console.log(`Verified ${expected.length} preview migrations. No household state imported or library seeded.`);
  } finally {
    client.release(true);
  }
} finally {
  await handle.close();
}
