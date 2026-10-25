import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { loadData } from "../lib/data/load";
import { seedDatabase } from "../lib/db/seed";
import * as schema from "../lib/db/schema";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { previewPreflight } from "../lib/deployment/preflight";
import { previewMigrationTarget, requireMigrationPrefix, requirePreviewLibraryOnly } from "../lib/deployment/preview-migration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = previewMigrationTarget(process.env);
const report = await previewPreflight(process.env, true);
if (!report.configurationValid || !report.liveBranchVerified) throw new Error("Preview library preflight refused.");
const data = loadData(root);
if (data.issues.length) throw new Error(`Preview library is invalid: ${data.issues.map((issue) => `${issue.file}: ${issue.message}`).join("; ")}`);
const handle = await openVerifiedPostgres(target);
try {
  const client = await handle.pool.connect();
  try {
    await client.query("select pg_advisory_lock(197548, 1)");
    const expected = readMigrationFiles({ migrationsFolder: path.join(root, "db/postgres-migrations") });
    const { rows } = await client.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id");
    requireMigrationPrefix(rows, expected, true);
    await requirePreviewLibraryOnly(client);
    const result = await seedDatabase(drizzle(client, { schema }), data);
    console.log(`Preview library seeded: ${result.ingredients} ingredients, ${result.recipes} recipes/components. No household data imported.`);
  } finally {
    client.release(true);
  }
} finally {
  await handle.close();
}
