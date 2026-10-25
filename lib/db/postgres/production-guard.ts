/** Stable, value-free error codes for every production refusal. Messages never contain configuration values. */
export type ProductionGuardCode =
  | "PRODUCTION_CONTEXT_REFUSED" | "PRODUCTION_PIN_MISSING" | "PRODUCTION_HOST_MISMATCH"
  | "PRODUCTION_DIRECT_REQUIRED" | "PRODUCTION_POOLER_REQUIRED" | "PRODUCTION_NEON_CONFIG_MISSING"
  | "PRODUCTION_NEON_UNREACHABLE" | "PRODUCTION_NEON_INVALID" | "PRODUCTION_BRANCH_MISMATCH"
  | "PRODUCTION_BRANCH_NOT_READY" | "PRODUCTION_ENDPOINT_MISMATCH";

export class ProductionGuardError extends Error {
  override name = "ProductionGuardError";
  constructor(readonly code: ProductionGuardCode, message: string) {
    super(`${code}: ${message}`);
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Production writes (migrate, seed, import, backup) are allowed only from the main-branch GitHub Actions job that
 * carries the production deployment marker. A laptop, a preview-labelled run or any other ref is refused.
 * The marker is a guard against mistakes; the GitHub environment approval is the real control.
 */
export function isProductionCiContext(env: Environment): boolean {
  return env.GITHUB_ACTIONS === "true" && env.GITHUB_REF === "refs/heads/main" &&
    env.DEPLOYMENT_ENVIRONMENT === "production" && !env.VERCEL && !env.VERCEL_ENV;
}

export function requireProductionCiContext(env: Environment): void {
  if (!isProductionCiContext(env)) {
    throw new ProductionGuardError(
      "PRODUCTION_CONTEXT_REFUSED",
      "Production migrate, seed, import and restore run only from the approved main-branch GitHub Actions production job.",
    );
  }
}

/** The running application: Vercel production only, never `next start` on another machine. */
export function isProductionRuntimeContext(env: Environment): boolean {
  return env.VERCEL === "1" && env.VERCEL_ENV === "production";
}

export function requireProductionRuntimeContext(env: Environment): void {
  if (!isProductionRuntimeContext(env)) {
    throw new ProductionGuardError("PRODUCTION_CONTEXT_REFUSED", "The production database is reachable only from the Vercel production runtime.");
  }
}

/** Neon labels the pooled endpoint `<endpoint-id>-pooler`. */
export function isPoolerHost(hostname: string): boolean {
  return (hostname.split(".")[0] ?? "").endsWith("-pooler");
}

export function directHostOf(pooledHost: string): string {
  const [label = "", ...domain] = pooledHost.split(".");
  return [label.replace(/-pooler$/, ""), ...domain].join(".");
}
