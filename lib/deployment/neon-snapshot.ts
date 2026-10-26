import { requireProductionCiContext } from "../db/postgres/production-guard";
import { productionPins } from "../db/postgres/verify-production";
import type { NeonAdmin } from "./neon-admin";
import { NeonAdminError } from "./neon-admin";

type Environment = Readonly<Record<string, string | undefined>>;

export const SNAPSHOT_PREFIX = "pre-deploy-";
export const SNAPSHOT_NAME_PATTERN = /^pre-deploy-\d{8}T\d{6}Z-[0-9a-f]{7}$/;
/** Free plan: keep the newest few and prune strictly. */
export const SNAPSHOT_KEEP = 5;
export const DEFAULT_RETENTION_DAYS = 7;

export function snapshotName(now: Date, sha: string | undefined): string {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new NeonAdminError("NEON_ADMIN_CONFIG", "GITHUB_SHA must be a full commit hash.");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${SNAPSHOT_PREFIX}${stamp}-${sha.slice(0, 7)}`;
}

export function retentionDays(env: Environment): number {
  const raw = env.SNAPSHOT_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || days < 1 || days > 30) {
    throw new NeonAdminError("NEON_ADMIN_CONFIG", "SNAPSHOT_RETENTION_DAYS must be a whole number from 1 to 30.");
  }
  return days;
}

export interface SnapshotResult { name: string; id: string }

/**
 * Creates `pre-deploy-<timestamp>-<sha7>` from the production branch with no compute endpoint, waits until it is
 * ready, then prunes old snapshots. Refused outside the approved production CI job.
 */
export async function createPreDeploySnapshot(env: Environment, admin: NeonAdmin, now: Date = new Date()): Promise<SnapshotResult> {
  requireProductionCiContext(env);
  const { project, branch } = productionPins(env);
  const name = snapshotName(now, env.GITHUB_SHA);
  const expires = new Date(now.getTime() + retentionDays(env) * 86_400_000).toISOString();
  const created = await admin.createBranch(project, { parent_id: branch, name, expires_at: expires });
  await admin.prune(project, { prefix: SNAPSHOT_PREFIX, namePattern: SNAPSHOT_NAME_PATTERN, keep: SNAPSHOT_KEEP });
  return { name: created.name, id: created.id };
}
