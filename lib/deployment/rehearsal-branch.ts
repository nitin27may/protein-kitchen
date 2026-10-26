import { directHostOf, isPoolerHost } from "../db/postgres/production-guard";
import { productionPins } from "../db/postgres/verify-production";
import type { NeonAdmin } from "./neon-admin";
import { NeonAdminError } from "./neon-admin";

type Environment = Readonly<Record<string, string | undefined>>;

export const REHEARSAL_PREFIX = "rehearse-";
export const REHEARSAL_TTL_HOURS = 24;

/** Rehearsal branches exist only inside GitHub Actions. */
export function requireRehearsalCi(env: Environment): void {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new NeonAdminError("NEON_ADMIN_REFUSED_TARGET", "Rehearsal branches are created, read and deleted only from GitHub Actions.");
  }
}

export function rehearsalName(sha: string | undefined, run: string | undefined): string {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new NeonAdminError("NEON_ADMIN_CONFIG", "GITHUB_SHA must be a full commit hash.");
  if (!run || !/^\d{1,12}$/.test(run)) throw new NeonAdminError("NEON_ADMIN_CONFIG", "GITHUB_RUN_ID must be a number.");
  return `${REHEARSAL_PREFIX}${sha.slice(0, 7)}-${run}`;
}

export interface RehearsalOutput {
  /** Workflow commands and environment lines are written through these so tests can capture them. */
  log(line: string): void;
  appendEnv(line: string): void;
}

export interface RehearsalIdentity { name: string; id: string }

function names(env: Environment): { database: string; role: string } {
  const database = env.NEON_DATABASE_NAME, role = env.NEON_ROLE_NAME;
  if (!database || !role) throw new NeonAdminError("NEON_ADMIN_CONFIG", "NEON_DATABASE_NAME and NEON_ROLE_NAME are required.");
  return { database, role };
}

function hostOf(uri: string): URL {
  try { return new URL(uri); } catch { throw new NeonAdminError("NEON_ADMIN_INVALID", "Neon returned a malformed connection URI."); }
}

/**
 * Creates `rehearse-<sha7>-<run>` as a child of the production branch with a read-write endpoint and a 24 hour expiry.
 * A child of a protected branch gets new credentials, so both URIs are fetched fresh through the API, masked, and only
 * the direct one is exported (with its host and the branch id).
 */
export async function createRehearsalBranch(env: Environment, admin: NeonAdmin, out: RehearsalOutput, now: Date = new Date()): Promise<RehearsalIdentity> {
  requireRehearsalCi(env);
  const { project, branch: parent } = productionPins(env);
  const { database, role } = names(env);
  const name = rehearsalName(env.GITHUB_SHA, env.GITHUB_RUN_ID);
  const created = await admin.createBranch(project, {
    parent_id: parent, name, expires_at: new Date(now.getTime() + REHEARSAL_TTL_HOURS * 3_600_000).toISOString(),
    endpoints: [{ type: "read_write" }],
  });
  const pooled = await admin.connectionUri(project, { branch_id: created.id, database_name: database, role_name: role, pooled: true });
  const direct = await admin.connectionUri(project, { branch_id: created.id, database_name: database, role_name: role, pooled: false });
  const pooledUrl = hostOf(pooled), directUrl = hostOf(direct);
  // Mask before anything else can print them. The password is masked on its own as well, in case a tool prints a part.
  for (const secret of [pooled, direct, decodeURIComponent(directUrl.password), decodeURIComponent(pooledUrl.password)]) {
    if (secret) out.log(`::add-mask::${secret}`);
  }
  if (!directUrl.hostname.endsWith(".neon.tech") || isPoolerHost(directUrl.hostname) || !isPoolerHost(pooledUrl.hostname) ||
      directHostOf(pooledUrl.hostname) !== directUrl.hostname || /[\r\n]/.test(direct)) {
    throw new NeonAdminError("NEON_ADMIN_INVALID", "Neon returned connection URIs that do not belong to one endpoint.");
  }
  out.appendEnv(`DATABASE_URL_UNPOOLED=${direct}`);
  out.appendEnv(`DATABASE_NONPRODUCTION_HOST=${directUrl.hostname}`);
  out.appendEnv(`NEON_DEVELOPMENT_BRANCH_ID=${created.id}`);
  return { name: created.name, id: created.id };
}

/** Throws unless NEON_DEVELOPMENT_BRANCH_ID is a `rehearse-` branch of the pinned project that is not production. */
export async function requireRehearsalBranch(env: Environment, admin: NeonAdmin): Promise<RehearsalIdentity> {
  requireRehearsalCi(env);
  const { project, branch: production } = productionPins(env);
  const id = env.NEON_DEVELOPMENT_BRANCH_ID;
  if (!id || id === production) throw new NeonAdminError("NEON_ADMIN_REFUSED_TARGET", "A rehearsal branch id is required and it must not be production.");
  const branch = await admin.getBranch(project, id);
  if (branch.id !== id || !branch.name.startsWith(REHEARSAL_PREFIX) || branch.default || branch.primary || branch.protected) {
    throw new NeonAdminError("NEON_ADMIN_REFUSED_TARGET", "The target is not a disposable rehearsal branch.");
  }
  return { name: branch.name, id: branch.id };
}

/** Deletes the rehearsal branch. A branch that is already gone (expired or cleaned up) is not an error. */
export async function deleteRehearsalBranch(env: Environment, admin: NeonAdmin): Promise<"deleted" | "absent"> {
  requireRehearsalCi(env);
  const { project, branch: production } = productionPins(env);
  const id = env.NEON_DEVELOPMENT_BRANCH_ID;
  if (!id || id === production) throw new NeonAdminError("NEON_ADMIN_REFUSED_TARGET", "A rehearsal branch id is required and it must not be production.");
  try {
    await admin.deleteBranch(project, id, [REHEARSAL_PREFIX]);
    return "deleted";
  } catch (error) {
    if (error instanceof NeonAdminError && error.code === "NEON_ADMIN_NOT_FOUND") return "absent";
    throw error;
  }
}
