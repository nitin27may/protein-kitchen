import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handle = await openVerifiedPostgres(postgresMigrationTarget(process.env));
try {
  await migrate(handle.db, { migrationsFolder: path.join(root, "db", "postgres-migrations") });
  console.log("Postgres development/test migrations applied. No library or human-owned data was imported.");
} finally {
  await handle.close();
}
