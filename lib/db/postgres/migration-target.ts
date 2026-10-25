import { validatePostgresTarget } from "./target";
import { productionMigrationTarget } from "./production-target";
import type { PostgresTarget } from "./target";

/** Development/test anywhere; production only from the approved main-branch CI job (see production-target.ts). */
export function postgresMigrationTarget(env: Readonly<Record<string, string | undefined>>): PostgresTarget {
  const environment = env.DATABASE_ENV;
  if (environment === "production") return productionMigrationTarget(env);
  if (environment !== "development" && environment !== "test") {
    throw new Error("Postgres migrations currently require DATABASE_ENV=development or test. Preview is not enabled and production runs only from the approved CI job.");
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
