import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFsStore } from "../lib/blob/fs";
import { openDb } from "../lib/db/client";
import { checkPhotos } from "../lib/photos/check";

/**
 * Compares the photo rows in the database with the files in uploads/ (or UPLOADS_DIR).
 *   pnpm photos:check             report only
 *   pnpm photos:check --delete    also delete files no row points at
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createFsStore(process.env.UPLOADS_DIR ?? path.join(root, "uploads"));
const handle = await openDb();

const report = await checkPhotos(handle.db, store);
console.log(`${report.orphans.length} orphan file(s), ${report.missing.length} photo(s) with missing files`);
for (const o of report.orphans) console.log(`  orphan  ${o}`);
for (const m of report.missing) console.log(`  missing ${m.uid}: ${m.keys.join(", ")}`);
if (process.argv.includes("--delete")) {
  for (const o of report.orphans) await store.delete(o);
  console.log(`deleted ${report.orphans.length} orphan file(s)`);
}
await handle.close();
process.exitCode = report.missing.length ? 1 : 0;
