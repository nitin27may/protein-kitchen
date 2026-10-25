import { isPoolerHost, ProductionGuardError } from "./production-guard";
import { validatePostgresTarget } from "./target";
import type { PostgresTarget } from "./target";
import type { NeonControlPlane } from "./neon-control-plane";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ProductionPins { project: string; branch: string }

/** Reads the pins; never the API key. Values are format-checked so a name or path can not be injected into a URL. */
export function productionPins(env: Environment): ProductionPins {
  const project = env.NEON_PROJECT_ID, branch = env.NEON_PRODUCTION_BRANCH_ID;
  if (!project || !branch) {
    throw new ProductionGuardError("PRODUCTION_NEON_CONFIG_MISSING", "Production verification requires NEON_PROJECT_ID and NEON_PRODUCTION_BRANCH_ID.");
  }
  if (!/^[a-z0-9-]+$/.test(project) || !/^br-[a-z0-9-]+$/.test(branch)) {
    throw new ProductionGuardError("PRODUCTION_NEON_CONFIG_MISSING", "Neon verification requires explicit project and branch ids, not names or paths.");
  }
  return { project, branch };
}

/**
 * Control-plane verification of a production target: the branch is the pinned production branch, it is ready, and the
 * host is the unique read-write endpoint of that branch (the direct host, or its pooler). Never opens Postgres.
 */
export async function verifyProductionBranch(target: PostgresTarget, env: Environment, plane: NeonControlPlane): Promise<void> {
  const url = validatePostgresTarget(target);
  if (target.databaseEnvironment !== "production") {
    throw new ProductionGuardError("PRODUCTION_CONTEXT_REFUSED", "verifyProductionBranch applies to production targets only.");
  }
  const { project, branch: pinned } = productionPins(env);
  const branch = await plane.branch(project, pinned);
  if (branch.id !== pinned || branch.project_id !== project) {
    throw new ProductionGuardError("PRODUCTION_BRANCH_MISMATCH", "The branch is not the pinned production branch of the pinned project.");
  }
  if (branch.current_state !== "ready") {
    throw new ProductionGuardError("PRODUCTION_BRANCH_NOT_READY", "The production branch is not ready.");
  }
  const endpoints = await plane.endpoints(project, pinned);
  const pooled = isPoolerHost(url.hostname);
  const matches = endpoints.filter((endpoint) => {
    const [label = "", ...domain] = endpoint.host.split(".");
    const expected = pooled ? `${label}-pooler.${domain.join(".")}` : endpoint.host;
    return endpoint.project_id === project && endpoint.branch_id === pinned && endpoint.type === "read_write" &&
      endpoint.host.endsWith(".neon.tech") && label === endpoint.id && url.hostname === expected;
  });
  if (matches.length !== 1) {
    throw new ProductionGuardError("PRODUCTION_ENDPOINT_MISMATCH", "The host is not the unique read-write endpoint of the production branch.");
  }
}
