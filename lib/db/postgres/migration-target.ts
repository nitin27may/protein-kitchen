import { validatePostgresTarget } from "./target";
import type { PostgresTarget } from "./target";

/** Deliberately development/test only until the production migration and cutover procedure is implemented. */
export function postgresMigrationTarget(env: Readonly<Record<string, string | undefined>>): PostgresTarget {
  const environment = env.DATABASE_ENV;
  if (environment !== "development" && environment !== "test") {
    throw new Error("Postgres migrations currently require DATABASE_ENV=development or test. Production and preview are not enabled.");
  }
  if (!env.DATABASE_URL_UNPOOLED) {
    throw new Error("Postgres migrations require DATABASE_URL_UNPOOLED; the application URL is never used as a fallback.");
  }
  const target: PostgresTarget = {
    connectionString: env.DATABASE_URL_UNPOOLED,
    runtimeEnvironment: environment,
    databaseEnvironment: environment,
    nonProductionHost: env.DATABASE_NONPRODUCTION_HOST,
  };
  const url = validatePostgresTarget(target);
  if (url.hostname.split(".")[0]?.endsWith("-pooler")) {
    throw new Error("Postgres migrations require a direct endpoint, not a Neon pooler endpoint.");
  }
  return target;
}
