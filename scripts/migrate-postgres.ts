import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { loadMigrationArtifacts, runGuardedMigration } from "../lib/deployment/run-migration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folder = path.join(root, "db", "postgres-migrations");
const target = postgresMigrationTarget(process.env);
const artifacts = loadMigrationArtifacts(folder);
const handle = await openVerifiedPostgres(target);
try {
  // One dedicated client: the lock, timeouts and DDL share a session that is destroyed afterwards.
  const client = await handle.pool.connect();
  try {
    const { applied } = await runGuardedMigration({
      session: client, artifacts, apply: () => migrate(drizzle(client), { migrationsFolder: folder }),
    });
    console.log(`Postgres ${target.databaseEnvironment} migrations applied and verified (${applied}). No library or human-owned data was imported.`);
  } finally {
    client.release(true);
  }
} finally {
  await handle.close();
}
