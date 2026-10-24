import { getBlobStore } from "../blob";
import { getDb } from "../server/context";
import { StateSyncConfigurationError, stateSyncConfiguration } from "./config";
import { openPrivateStateRepository } from "./github";
import { readStateRunStatus, runStateSync } from "./run";
import { readStateSyncStatus } from "./snapshot";
import { localStateTestFetch } from "./test-fetch";

export async function configuredStateSync(requestId?: string) {
  const config = stateSyncConfiguration(process.env);
  // Validate the synthetic boundary before any database/credential operation.
  const fetcher = process.env.STATE_SYNC_TEST_GITHUB_URL ? localStateTestFetch(process.env) : fetch;
  return runStateSync(await getDb(), config.targetKey, config.classes, {
    repository: () => openPrivateStateRepository(config.github, fetcher),
    store: { get: (key) => getBlobStore().get(key) },
  }, requestId);
}

export async function stateSyncSettings() {
  let config;
  try { config = stateSyncConfiguration(process.env); }
  catch (error) {
    if (!(error instanceof StateSyncConfigurationError)) throw error;
    return { enabled: false as const, reason: error.message };
  }
  const db = await getDb();
  const [run, classes] = await Promise.all([readStateRunStatus(db, config.targetKey), readStateSyncStatus(db, config.classes)]);
  return {
    enabled: true as const, run,
    classes: classes.map((item) => ({ ...item, pending: item.revision === 0 || item.revision > (run.acknowledged[item.dataClass] ?? 0) })),
  };
}
