import { postgresMigrationTarget } from "./migration-target";

/** Remote imports stay blocked until real Neon branch-to-endpoint verification has been added. */
export function sqliteImportTarget(env: Readonly<Record<string, string | undefined>>) {
  const target = postgresMigrationTarget(env);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.connectionString).hostname)) {
    throw new Error("SQLite import currently supports loopback dev/test destinations only. Remote branch verification is required first.");
  }
  return target;
}
