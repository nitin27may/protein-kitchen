import { postgresMigrationTarget } from "./migration-target";

/** Remote rehearsals require a second explicit branch pin in addition to live pool verification. */
export function sqliteImportTarget(env: Readonly<Record<string, string | undefined>>) {
  const target = postgresMigrationTarget(env);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.connectionString).hostname)) {
    if (!env.SQLITE_IMPORT_NEON_BRANCH_ID || env.SQLITE_IMPORT_NEON_BRANCH_ID !== env.NEON_DEVELOPMENT_BRANCH_ID) {
      throw new Error("Remote SQLite rehearsal requires SQLITE_IMPORT_NEON_BRANCH_ID to explicitly match NEON_DEVELOPMENT_BRANCH_ID; loopback imports need no remote opt-in.");
    }
  }
  return target;
}
