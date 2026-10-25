import type { DatabaseEnvironment, PostgresTarget } from "./target";
import { validatePostgresTarget } from "./target";

const environments: readonly string[] = ["development", "test", "preview", "production"];

export function runtimeTarget(env: Readonly<Record<string, string | undefined>>): PostgresTarget {
  const runtime = env.VERCEL_ENV ?? env.NODE_ENV;
  if (!runtime || !environments.includes(runtime)) throw new Error("Postgres requires an explicit runtime environment.");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required. SQLite fallback and request-time migrations are disabled.");
  if (!env.DATABASE_ENV || !environments.includes(env.DATABASE_ENV)) {
    throw new Error("DATABASE_ENV must explicitly identify the database environment.");
  }
  const target: PostgresTarget = {
    connectionString: env.DATABASE_URL,
    runtimeEnvironment: runtime as DatabaseEnvironment,
    databaseEnvironment: env.DATABASE_ENV as DatabaseEnvironment,
    nonProductionHost: env.DATABASE_NONPRODUCTION_HOST,
  };
  validatePostgresTarget(target);
  return target;
}
