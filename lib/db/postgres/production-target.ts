import { isPoolerHost, ProductionGuardError, requireProductionCiContext } from "./production-guard";
import { validatePostgresTarget } from "./target";
import type { PostgresTarget } from "./target";

type Environment = Readonly<Record<string, string | undefined>>;

function target(connectionString: string | undefined, pin: string | undefined): PostgresTarget {
  if (!connectionString || !pin) {
    throw new ProductionGuardError("PRODUCTION_PIN_MISSING", "Production requires the connection URL and its reviewed host pin.");
  }
  return { connectionString, runtimeEnvironment: "production", databaseEnvironment: "production", productionHost: pin };
}

/** Pooled application connection. Pure configuration; context is enforced by the caller (runtime or check). */
export function productionPooledTarget(env: Environment): PostgresTarget {
  const result = target(env.DATABASE_URL, env.DATABASE_PRODUCTION_HOST);
  if (!isPoolerHost(validatePostgresTarget(result).hostname)) {
    throw new ProductionGuardError("PRODUCTION_POOLER_REQUIRED", "The production runtime connects through the pooled endpoint.");
  }
  return result;
}

/** Direct connection for read-only checks and migrations. Context is enforced by the caller. */
export function productionDirectTarget(env: Environment): PostgresTarget {
  const result = target(env.DATABASE_URL_UNPOOLED, env.DATABASE_DIRECT_PRODUCTION_HOST);
  if (isPoolerHost(validatePostgresTarget(result).hostname)) {
    throw new ProductionGuardError("PRODUCTION_DIRECT_REQUIRED", "Production migrations require the direct endpoint, not the pooler.");
  }
  return result;
}

/** Write-capable production target: the CI context is checked before anything else is read. */
export function productionMigrationTarget(env: Environment): PostgresTarget {
  requireProductionCiContext(env);
  return productionDirectTarget(env);
}
