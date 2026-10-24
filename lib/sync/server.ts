import { getBlobStore } from "../blob";
import { getDb } from "../server/context";
import { StateSyncConfigurationError, stateSyncConfiguration } from "./config";
import { openPrivateStateRepository } from "./github";
import { readStateRunStatus, runStateSync } from "./run";
import { readStateSyncStatus } from "./snapshot";
import { localStateTestFetch } from "./test-fetch";
import { requireMember } from "../auth/access";
import { memberHouseholdAccess, requireHouseholdProfile } from "../auth/household-access";
import { HouseholdAccessError } from "../auth/household";
import type { Db } from "../db/client";

async function configuredOwner(db: Db, householdId: string) {
  const member = await requireMember();
  const access = await memberHouseholdAccess(db, member);
  requireHouseholdProfile(access);
  if (access.householdId !== householdId || access.role !== "owner") {
    throw new HouseholdAccessError("Private shared-state sync is not configured for this household.");
  }
  return access;
}

export async function configuredStateSync(requestId?: string, interactive = false) {
  const config = stateSyncConfiguration(process.env);
  // Validate the synthetic boundary before any database/credential operation.
  const fetcher = process.env.STATE_SYNC_TEST_GITHUB_URL ? localStateTestFetch(process.env) : fetch;
  const db = await getDb();
  const access = interactive ? await configuredOwner(db, config.householdId) : undefined;
  return runStateSync(db, config.targetKey, config.classes, {
    repository: () => openPrivateStateRepository(config.github, fetcher),
    store: { get: (key) => getBlobStore().get(key) },
  }, requestId, { householdId: config.householdId, access });
}

export async function stateSyncSettings() {
  let config;
  try { config = stateSyncConfiguration(process.env); }
  catch (error) {
    if (!(error instanceof StateSyncConfigurationError)) throw error;
    return { enabled: false as const, reason: error.message };
  }
  const db = await getDb();
  try { await configuredOwner(db, config.householdId); }
  catch (error) {
    if (!(error instanceof HouseholdAccessError)) throw error;
    return { enabled: false as const, reason: error.message };
  }
  const [run, classes] = await Promise.all([
    readStateRunStatus(db, config.targetKey, config.householdId), readStateSyncStatus(db, config.classes, config.householdId),
  ]);
  return {
    enabled: true as const, run,
    classes: classes.map((item) => ({ ...item, pending: item.revision === 0 || item.revision > (run.acknowledged[item.dataClass] ?? 0) })),
  };
}
