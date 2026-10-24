import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { GitHubStateConfiguration, PrivateStateRepository } from "./github";
import { StateGitHubError } from "./github";
import { publicationHashes, publishState, reconcileState, statePayload, StateSyncConflict } from "./publish";
import { acknowledgeStateSnapshot, captureStateSnapshot, selectedStateClasses } from "./snapshot";

export type SyncResult = { state: "success" | "busy" | "error" | "conflict"; replayed: boolean };
const pendingSchema = z.object({
  revisions: z.record(z.number().int().positive().safe()), files: z.record(z.string().regex(/^[0-9a-f]{40}$/)),
}).strict();
const clock = sql`clock_timestamp()`;
const deadline = sql`clock_timestamp() + interval '120 seconds'`;

export function stateTargetKey(config: Pick<GitHubStateConfiguration, "repositoryId" | "owner" | "repository" | "branch">) {
  return createHash("sha256").update(JSON.stringify([
    config.repositoryId, config.owner.toLowerCase(), config.repository.toLowerCase(), config.branch,
  ])).digest("hex");
}

export class StateSyncLeaseLost extends Error {
  constructor() { super("Private state sync lease expired or moved to another worker. Retry."); }
}

function leaseWhere(targetKey: string, leaseToken: string) {
  return and(eq(s.stateSyncJobs.targetKey, targetKey), eq(s.stateSyncJobs.leaseToken, leaseToken), gt(s.stateSyncJobs.leaseExpiresAt, clock));
}

/** Every lease transaction is short; no remote or blob operations run inside it. */
export async function runStateSync(
  db: Db, targetKey: string, names: readonly string[],
  dependencies: { repository(): Promise<PrivateStateRepository>; store: Pick<BlobStore, "get"> },
  requestId: string = randomUUID(),
): Promise<SyncResult> {
  const selected = selectedStateClasses(names);
  if (!/^[0-9a-f]{64}$/.test(targetKey) || !z.string().uuid().safeParse(requestId).success) throw new Error("Invalid state-sync target or request id.");
  requestId = requestId.toLowerCase();
  const leaseToken = randomUUID();
  const admission = await db.transaction(async (tx) => {
    await tx.insert(s.stateSyncJobs).values({ targetKey }).onConflictDoNothing();
    const [row] = await tx.select({ job: s.stateSyncJobs, active: sql<boolean>`${s.stateSyncJobs.leaseExpiresAt} > clock_timestamp()` })
      .from(s.stateSyncJobs).where(eq(s.stateSyncJobs.targetKey, targetKey)).for("update");
    const [previous] = await tx.select().from(s.stateSyncRequests).where(eq(s.stateSyncRequests.id, requestId));
    if (previous && previous.targetKey !== targetKey) throw new Error("State-sync request belongs to a different target.");
    if (previous?.status === "success") return { result: { state: "success", replayed: true } as SyncResult };
    if (row!.job.leaseToken && row!.active) return { result: { state: "busy", replayed: false } as SyncResult };
    if (row!.job.leaseToken) {
      await tx.update(s.stateSyncRequests).set({ status: "error", completedAt: clock })
        .where(and(eq(s.stateSyncRequests.targetKey, targetKey), eq(s.stateSyncRequests.status, "running")));
    }
    const requests = await tx.insert(s.stateSyncRequests).values({ id: requestId, targetKey, status: "running", startedAt: clock })
      .onConflictDoUpdate({
        target: s.stateSyncRequests.id, set: { status: "running", startedAt: clock, completedAt: null },
        setWhere: eq(s.stateSyncRequests.targetKey, targetKey),
      }).returning();
    if (!requests.length) throw new Error("State-sync request belongs to a different target.");
    await tx.update(s.stateSyncJobs).set({
      status: "running", leaseToken, leaseExpiresAt: deadline, lastAttemptAt: clock, errorCode: null,
    }).where(eq(s.stateSyncJobs.targetKey, targetKey));
    return { pending: row!.job.pending, checkpoint: row!.job.checkpointCommit };
  });
  if ("result" in admission) return admission.result!;
  async function renew() {
    const rows = await db.update(s.stateSyncJobs).set({ leaseExpiresAt: deadline }).where(leaseWhere(targetKey, leaseToken)).returning();
    if (!rows.length) throw new StateSyncLeaseLost();
  }
  async function complete(commit: string, revisions: Record<string, number>) {
    await db.transaction(async (tx) => {
      const rows = await tx.update(s.stateSyncJobs).set({
        status: "success", checkpointCommit: commit, acknowledged: revisions, pending: null, lastSuccessAt: clock,
        leaseToken: null, leaseExpiresAt: null, errorCode: null,
      }).where(leaseWhere(targetKey, leaseToken)).returning();
      if (!rows.length) throw new StateSyncLeaseLost();
      await acknowledgeStateSnapshot(tx, revisions);
      await tx.update(s.stateSyncRequests).set({ status: "success", completedAt: clock }).where(eq(s.stateSyncRequests.id, requestId));
    });
  }
  try {
    await renew();
    const raw = await dependencies.repository();
    const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      await renew(); return fn(...args);
    };
    const repository: PrivateStateRepository = {
      head: guard(raw.head), commit: guard(raw.commit), tree: guard(raw.tree), blob: guard(raw.blob),
      createBlob: guard(raw.createBlob), createTree: guard(raw.createTree), createCommit: guard(raw.createCommit), advance: guard(raw.advance),
    };
    if (admission.pending) {
      const pending = pendingSchema.parse(admission.pending);
      selectedStateClasses(Object.keys(pending.revisions));
      const recovered = await reconcileState(repository, pending.files, admission.checkpoint);
      if (recovered.synchronized) {
        await complete(recovered.commit, pending.revisions);
        return { state: "success", replayed: false };
      }
    }
    await renew();
    const snapshot = await captureStateSnapshot(db, selected);
    const files = await statePayload(snapshot, { ...dependencies.store, get: guard(dependencies.store.get) });
    await renew();
    const rows = await db.update(s.stateSyncJobs).set({ pending: { revisions: snapshot.revisions, files: publicationHashes(files) } })
      .where(leaseWhere(targetKey, leaseToken)).returning();
    if (!rows.length) throw new StateSyncLeaseLost();
    const published = await publishState(repository, files, admission.checkpoint);
    await complete(published.commit, snapshot.revisions);
    return { state: "success", replayed: false };
  } catch (error) {
    const state = error instanceof StateSyncConflict ? "conflict" : "error";
    const code = error instanceof StateSyncConflict ? "remote-conflict" : error instanceof StateSyncLeaseLost ? "lease-lost" :
      error instanceof StateGitHubError ? "github-request-failed" : "sync-failed";
    console.error("Private state sync did not complete.", { code });
    await db.transaction(async (tx) => {
      const rows = await tx.update(s.stateSyncJobs).set({ status: state, leaseToken: null, leaseExpiresAt: null, errorCode: code })
        .where(leaseWhere(targetKey, leaseToken)).returning();
      if (rows.length) {
        await tx.update(s.stateSyncRequests).set({ status: state, completedAt: clock }).where(eq(s.stateSyncRequests.id, requestId));
      }
    });
    return { state, replayed: false };
  }
}

export async function readStateRunStatus(db: Db, targetKey: string) {
  const [row] = await db.select({
    status: s.stateSyncJobs.status, lastAttemptAt: s.stateSyncJobs.lastAttemptAt,
    lastSuccessAt: s.stateSyncJobs.lastSuccessAt, errorCode: s.stateSyncJobs.errorCode,
    acknowledged: s.stateSyncJobs.acknowledged,
    active: sql<boolean>`coalesce(${s.stateSyncJobs.leaseExpiresAt} > clock_timestamp(), false)`,
  }).from(s.stateSyncJobs).where(eq(s.stateSyncJobs.targetKey, targetKey));
  return row ?? { status: "idle" as const, lastAttemptAt: null, lastSuccessAt: null, errorCode: null, active: false, acknowledged: {} as Record<string, number> };
}
