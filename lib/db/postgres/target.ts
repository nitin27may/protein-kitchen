export type DatabaseEnvironment = "development" | "test" | "preview" | "production";

export interface PostgresTarget {
  connectionString: string;
  runtimeEnvironment: DatabaseEnvironment;
  databaseEnvironment: DatabaseEnvironment;
  /** Exact endpoint host reviewed as non-production; never infer it from a branch display name. */
  nonProductionHost?: string;
}

export function validatePostgresTarget(target: PostgresTarget): URL {
  let url: URL;
  try {
    url = new URL(target.connectionString);
  } catch {
    throw new Error("Postgres requires a valid connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname === "/" || !url.pathname) {
    throw new Error("Postgres requires a postgres:// or postgresql:// URL with a host and database.");
  }
  if (target.databaseEnvironment !== target.runtimeEnvironment) {
    throw new Error("Postgres database environment must match the runtime environment.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (target.runtimeEnvironment !== "production" && !local && url.hostname !== target.nonProductionHost) {
    throw new Error("Remote non-production Postgres requires an explicitly reviewed non-production endpoint host.");
  }
  // libpq parameters can override the validated URL host; accept a single, unambiguous network target only.
  if (["host", "hostaddr", "port", "dbname", "service", "servicefile"].some((key) => url.searchParams.has(key))) {
    throw new Error("Postgres connection URLs must not override the host, port, database or service in query parameters.");
  }
  if (!local && (url.searchParams.has("ssl") || (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full"))) {
    throw new Error("Remote Postgres connections require sslmode=verify-full or the secure default.");
  }
  if (!local) url.searchParams.set("sslmode", "verify-full");
  return url;
}
