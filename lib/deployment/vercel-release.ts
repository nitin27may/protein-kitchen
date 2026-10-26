import { z } from "zod";
import { vercelGet, VercelApiError } from "./vercel-project";
import type { VercelClientOptions } from "./vercel-project";

type Environment = Readonly<Record<string, string | undefined>>;

const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{6,64}$/;

/** The id of the newest READY production deployment, recorded before this release changes anything. Ids are not secret. */
export async function previousProductionDeployment(env: Environment, options: VercelClientOptions = {}): Promise<string | undefined> {
  const project = env.VERCEL_PROJECT_ID ?? "";
  const body = z.object({ deployments: z.array(z.object({ uid: z.string() }).passthrough()) }).passthrough().safeParse(
    await vercelGet(env, "/v6/deployments", { projectId: project, target: "production", state: "READY", limit: "1" }, options),
  );
  if (!body.success) throw new VercelApiError("VERCEL_INVALID", "The Vercel deployment listing has an unexpected shape.");
  const id = body.data.deployments[0]?.uid;
  return id !== undefined && DEPLOYMENT_ID.test(id) ? id : undefined;
}

/** Host of the deployment URL printed by `vercel deploy --json` (a bare host or an https URL, flat or under `deployment`). */
export function deployedHost(text: string): string {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new VercelApiError("VERCEL_INVALID", "The deploy output is not JSON."); }
  const flat = z.object({ url: z.string() }).safeParse(json);
  const nested = z.object({ deployment: z.object({ url: z.string() }) }).safeParse(json);
  const raw = flat.success ? flat.data.url : nested.success ? nested.data.deployment.url : undefined;
  if (raw === undefined) throw new VercelApiError("VERCEL_INVALID", "The deploy output has no deployment URL.");
  let url: URL;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { throw new VercelApiError("VERCEL_INVALID", "The deployment URL is malformed."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) {
    throw new VercelApiError("VERCEL_INVALID", "The deployment URL is not a bare vercel.app origin.");
  }
  return url.hostname;
}

const deploymentSchema = z.object({
  id: z.string(),
  readyState: z.string(),
  target: z.string().nullish(),
  alias: z.array(z.string()).nullish(),
  aliasAssigned: z.unknown().optional(),
}).passthrough();

async function deployment(env: Environment, host: string, options: VercelClientOptions) {
  const body = deploymentSchema.safeParse(await vercelGet(env, `/v13/deployments/${encodeURIComponent(host)}`, {}, options));
  if (!body.success || !DEPLOYMENT_ID.test(body.data.id)) throw new VercelApiError("VERCEL_INVALID", "The Vercel deployment response is unexpected.");
  return body.data;
}

/** The candidate must be READY and built for production, never a preview or an unfinished build. Returns its id. */
export async function requireReadyProduction(env: Environment, host: string, options: VercelClientOptions = {}): Promise<string> {
  const found = await deployment(env, host, options);
  if (found.readyState !== "READY") throw new VercelApiError("VERCEL_NOT_READY", "The candidate deployment is not READY.");
  if (found.target !== "production") throw new VercelApiError("VERCEL_WRONG_TARGET", "The candidate deployment does not target production.");
  return found.id;
}

export interface WaitOptions extends VercelClientOptions {
  sleep?: (ms: number) => Promise<void>; now?: () => number; intervalMs?: number; maxWaitMs?: number;
  /** The release (full commit SHA) the public health endpoint must report. Without it only the Aliases API proof is used. */
  release?: string;
}

const aliasSchema = z.object({ deploymentId: z.string().nullish() }).passthrough();
const healthSchema = z.object({ release: z.string() }).passthrough();

/**
 * Proof 1: the Aliases API says the production host points at the promoted deployment.
 *
 * UNVERIFIED against the live API (no remote contact was allowed while writing this). From Vercel's API reference,
 * `GET /v4/aliases/{idOrAlias}?teamId=...` is believed to return the alias record, with `deploymentId` naming the
 * deployment it serves. The earlier approach, reading `alias[]` from `GET /v13/deployments/{id}`, failed in the first
 * real run: that list held only the generated project alias, not the production project domain, although the domain
 * was serving the new release.
 */
async function aliasPointsAt(env: Environment, host: string, id: string, options: VercelClientOptions): Promise<boolean> {
  const body = aliasSchema.safeParse(await vercelGet(env, `/v4/aliases/${encodeURIComponent(host)}`, {}, options));
  return body.success && body.data.deploymentId === id;
}

/**
 * Proof 2: the public health endpoint (returns only ok, release, database, library) reports the expected release.
 * The origin is fixed from PRODUCTION_ORIGIN, nothing is sent but a plain GET, and redirects are an error.
 */
async function healthReports(origin: string, release: string | undefined, options: VercelClientOptions): Promise<boolean> {
  if (!release) return false;
  const response = await (options.request ?? fetch)(`${origin}/api/health`, {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(options.timeoutMs ?? 30_000), headers: { Accept: "application/json" },
  });
  if (!response.ok) return false;
  const body = healthSchema.safeParse(await response.json());
  return body.success && body.data.release === release;
}

/**
 * Waits until EITHER proof holds: the Aliases API points the production host at the promoted deployment, or the public
 * health endpoint reports the expected release. A failed or malformed answer from either source counts as "not yet",
 * never as an error, so one flaky source cannot block the other. Errors carry no URL, header, body or credential.
 */
export async function waitForAlias(env: Environment, id: string, productionOrigin: string, options: WaitOptions = {}): Promise<void> {
  if (!DEPLOYMENT_ID.test(id)) throw new VercelApiError("VERCEL_CONFIG", "The deployment id is malformed.");
  let origin: URL;
  try { origin = new URL(productionOrigin); } catch { throw new VercelApiError("VERCEL_CONFIG", "PRODUCTION_ORIGIN is malformed."); }
  if (origin.protocol !== "https:") throw new VercelApiError("VERCEL_CONFIG", "PRODUCTION_ORIGIN must be an https origin.");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxWaitMs ?? 180_000);
  for (;;) {
    const proofs = await Promise.all([
      aliasPointsAt(env, origin.hostname, id, options).catch(() => false),
      healthReports(origin.origin, options.release, options).catch(() => false),
    ]);
    if (proofs.some(Boolean)) return;
    if (now() >= deadline) throw new VercelApiError("VERCEL_ALIAS_TIMEOUT", "The production alias did not move to the promoted deployment in time.");
    await sleep(options.intervalMs ?? 5_000);
  }
}
