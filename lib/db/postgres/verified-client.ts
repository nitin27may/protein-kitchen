import { openPostgres } from "./client";
import { neonHttpControlPlane } from "./neon-control-plane";
import { isProductionCiContext, ProductionGuardError, requireProductionRuntimeContext } from "./production-guard";
import type { PostgresTarget } from "./target";
import { verifyNonProductionBranch } from "./verify-branch";
import { verifyProductionBranch } from "./verify-production";

type Environment = Readonly<Record<string, string | undefined>>;

export async function openVerifiedPostgres(target: PostgresTarget, env: Environment = process.env) {
  if (target.databaseEnvironment === "production") {
    if (isProductionCiContext(env)) {
      // Migration or seed from the approved job: the control plane proves branch and endpoint before any pool exists.
      if (!env.NEON_API_KEY) {
        throw new ProductionGuardError("PRODUCTION_NEON_CONFIG_MISSING", "The approved production job requires NEON_API_KEY for branch verification.");
      }
      await verifyProductionBranch(target, env, neonHttpControlPlane(env.NEON_API_KEY));
    } else {
      // Runtime: the host pin is the guard, so the running application needs no Neon API key.
      requireProductionRuntimeContext(env);
    }
  } else {
    await verifyNonProductionBranch(target, env);
  }
  return openPostgres(target);
}
