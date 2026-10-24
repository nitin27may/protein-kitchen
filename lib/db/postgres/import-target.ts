import { postgresMigrationTarget } from "./migration-target";

/** Remote imports stay blocked until the isolated cloud rehearsal is explicitly approved and enabled. */
export function sqliteImportTarget(env: Readonly<Record<string, string | undefined>>) {
  const target = postgresMigrationTarget(env);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(target.connectionString).hostname)) {
    throw new Error("SQLite import currently supports loopback dev/test destinations only. The isolated cloud rehearsal must be approved and enabled first.");
  }
  return target;
}
