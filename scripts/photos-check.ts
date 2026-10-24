import { getBlobStore } from "../lib/blob";
import { openDb } from "../lib/db/client";
import { checkPhotos } from "../lib/photos/check";

/**
 * Compares photo rows with the explicitly configured filesystem or private Neon blob store.
 *   pnpm photos:check             report only
 *   pnpm photos:check --delete    also delete files no row points at
 */
const store = getBlobStore();
const handle = await openDb();

try {
  const report = await checkPhotos(handle.db, store);
  console.log(`${report.orphans.length} orphan file(s), ${report.missing.length} photo(s) with missing files`);
  for (const o of report.orphans) console.log(`  orphan  ${o}`);
  for (const m of report.missing) console.log(`  missing ${m.uid}: ${m.keys.join(", ")}`);
  if (process.argv.includes("--delete")) {
    for (const o of report.orphans) await store.delete(o);
    console.log(`deleted ${report.orphans.length} orphan file(s)`);
  }
  process.exitCode = report.missing.length ? 1 : 0;
} finally { await handle.close(); }
