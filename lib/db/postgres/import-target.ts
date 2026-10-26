import { postgresMigrationTarget } from "./migration-target";

/** Remote rehearsals require a second explicit branch pin in addition to live pool verification. */
export function sqliteImportTarget(env: Readonly<Record<string, string | undefined>>) {
  const target = postgresMigrationTarget(env);
  // Legacy import is a development/test rehearsal tool and never writes to production, even from the approved job.
  if (env.DATABASE_ENV === "production") throw new Error("SQLite import never targets production.");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.connectionString).hostname)) {
    const expected = env.NEON_DEVELOPMENT_BRANCH_ID;
    if (!env.SQLITE_IMPORT_NEON_BRANCH_ID || env.SQLITE_IMPORT_NEON_BRANCH_ID !== expected) {
      throw new Error("Remote SQLite import requires SQLITE_IMPORT_NEON_BRANCH_ID to explicitly match the target environment's Neon branch id; loopback imports need no remote opt-in.");
    }
  }
  return target;
}
