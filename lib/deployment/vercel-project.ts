import fs from "node:fs";
import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;

/** The only origin this module talks to. Redirects are an error, so a token can never follow a 3xx elsewhere. */
export const VERCEL_API_ORIGIN = "https://api.vercel.com";

/**
 * Value of `ssoProtection.deploymentType` that means "Standard Protection": the generated deployment URLs are behind
 * Vercel Authentication and the production custom domain is public.
 *
 * UNVERIFIED against the live API (no remote contact was allowed while writing this). From Vercel's API reference the
 * enum is `all` | `preview` | `prod_deployment_urls_and_all_previews` | `all_except_custom_domains`, and Standard
 * Protection is believed to be `all_except_custom_domains`. `all` would also lock the public production domain.
 * Anything else, including null or a missing object, is refused (fail closed). If the first run refuses a correctly
 * configured project, read the value in the Vercel dashboard network tab, then change only this constant.
 */
export const STANDARD_PROTECTION_TYPE = "all_except_custom_domains";

export class VercelApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "VercelApiError";
  }
}

export interface VercelClientOptions { request?: typeof fetch; timeoutMs?: number }

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function settings(env: Environment): { token: string; project: string; team: string | undefined } {
  const token = env.VERCEL_TOKEN, project = env.VERCEL_PROJECT_ID, team = env.VERCEL_ORG_ID;
  if (!token) throw new VercelApiError("VERCEL_CONFIG", "VERCEL_TOKEN is required.");
  if (!project || !ID.test(project)) throw new VercelApiError("VERCEL_CONFIG", "VERCEL_PROJECT_ID is missing or malformed.");
  if (!team || !ID.test(team)) throw new VercelApiError("VERCEL_CONFIG", "VERCEL_ORG_ID is missing or malformed.");
  // Like the CLI, only a team id is sent as teamId; a personal account id is implied by the token.
  return { token, project, team: team.startsWith("team_") ? team : undefined };
}

/** GET with a fixed origin. No error carries a URL, header, body or credential. */
export async function vercelGet(env: Environment, path: string, query: Record<string, string>, options: VercelClientOptions = {}): Promise<unknown> {
  const { token, team } = settings(env);
  const url = new URL(path, VERCEL_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (team) url.searchParams.set("teamId", team);
  let response: Response;
  try {
    response = await (options.request ?? fetch)(url.toString(), {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    throw new VercelApiError("VERCEL_UNREACHABLE", "The Vercel API could not be reached.");
  }
  if (!response.ok) throw new VercelApiError("VERCEL_HTTP", `The Vercel API answered HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new VercelApiError("VERCEL_INVALID", "The Vercel API returned a response that is not JSON.");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime manifest
// ---------------------------------------------------------------------------------------------------------------

const envListSchema = z.object({
  envs: z.array(z.object({
    key: z.string().min(1),
    type: z.string().min(1),
    value: z.string().optional(),
    target: z.union([z.string(), z.array(z.string())]).nullish(),
  }).passthrough()),
  pagination: z.object({ next: z.unknown().nullish() }).passthrough().nullish(),
}).passthrough();

export interface ManifestEntry { key: string; type: string; target: string[]; value?: string }

/**
 * Name, type and target of every project variable; the value only when the type is `plain`. Sensitive, secret and
 * encrypted values never reach the result, even if the API returns them.
 */
export async function buildRuntimeManifest(env: Environment, options: VercelClientOptions = {}): Promise<ManifestEntry[]> {
  const { project } = settings(env);
  const body = envListSchema.safeParse(await vercelGet(env, `/v10/projects/${project}/env`, { decrypt: "false" }, options));
  if (!body.success) throw new VercelApiError("VERCEL_INVALID", "The Vercel environment listing has an unexpected shape.");
  // An unseen second page would hide a forbidden variable, so any further page fails closed.
  if (body.data.pagination?.next) throw new VercelApiError("VERCEL_INVALID", "The Vercel environment listing is paginated; refusing a partial view.");
  return body.data.envs.map((entry) => {
    const target = entry.target === undefined || entry.target === null ? [] : Array.isArray(entry.target) ? entry.target : [entry.target];
    return entry.type === "plain" && entry.value !== undefined
      ? { key: entry.key, type: entry.type, target, value: entry.value }
      : { key: entry.key, type: entry.type, target };
  });
}

export function writeRuntimeManifest(file: string, entries: readonly ManifestEntry[]): void {
  fs.writeFileSync(file, `${JSON.stringify({ envs: entries }, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------------------------
// Deployment protection
// ---------------------------------------------------------------------------------------------------------------

const projectSchema = z.object({
  id: z.string(),
  ssoProtection: z.object({ deploymentType: z.string().nullish() }).passthrough().nullish(),
}).passthrough();

export async function assertStandardProtection(env: Environment, options: VercelClientOptions = {}): Promise<void> {
  const { project } = settings(env);
  const body = projectSchema.safeParse(await vercelGet(env, `/v9/projects/${project}`, {}, options));
  if (!body.success || body.data.id !== project) throw new VercelApiError("VERCEL_INVALID", "The Vercel project response is unexpected.");
  if (body.data.ssoProtection?.deploymentType !== STANDARD_PROTECTION_TYPE) {
    throw new VercelApiError("VERCEL_PROTECTION_NOT_STANDARD", "Vercel Deployment Protection must be Standard Protection before a candidate is uploaded.");
  }
}
