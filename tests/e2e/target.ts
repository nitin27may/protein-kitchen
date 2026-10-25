import { validatePostgresTarget } from "../../lib/db/postgres/target";

/** This database is disposable: setup migrates and clears all application tables. */
export function e2eTarget(connectionString: string | undefined) {
  if (!connectionString) throw new Error("POSTGRES_E2E_URL must explicitly select a disposable loopback protein_kitchen_e2e database.");
  const target = { connectionString, runtimeEnvironment: "test", databaseEnvironment: "test" } as const;
  const url = validatePostgresTarget(target);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/protein_kitchen_e2e") {
    throw new Error("Browser tests require the disposable loopback-only protein_kitchen_e2e database.");
  }
  return target;
}
