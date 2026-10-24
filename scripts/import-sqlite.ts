import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { sqliteImportTarget } from "../lib/db/postgres/import-target";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";

if (process.argv.length !== 3) throw new Error("Usage: pnpm db:import:sqlite /absolute/path/to/private-source-copy.db");
const file = process.argv[2]!;
if (!path.isAbsolute(file)) throw new Error("SQLite import requires an explicit absolute source path.");
const target = sqliteImportTarget(process.env);
const snapshot = readSqliteSnapshot(file);
const handle = await openVerifiedPostgres(target);
try {
  const report = await restoreSqliteSnapshot(handle.db, snapshot).catch((error: unknown) => {
    if (!(error instanceof DrizzleQueryError)) throw error;
    // Driver errors may embed SQL parameters containing human-owned data.
    throw new Error("SQLite import failed and was rolled back. Check schema compatibility, constraints and target availability before retrying; no source data was changed.");
  });
  console.log("SQLite import verified and committed to the explicit empty dev/test destination.");
  for (const [table, digest] of Object.entries(report).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${table}: ${digest.count} rows, sha256 ${digest.sha256}`);
  }
  console.log("No source changes or photo-byte transfer. Run the guarded library seed before starting the app.");
} finally {
  await handle.close();
}
