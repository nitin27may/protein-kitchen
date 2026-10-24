import { authorizeScheduler } from "../server/scheduler";
import { githubStateConfiguration } from "./github";
import { stateTargetKey } from "./run";
import { selectedStateClasses } from "./snapshot";

type Environment = Readonly<Record<string, string | undefined>>;
export class StateSyncConfigurationError extends Error {
  constructor() { super("Private state sync is not configured on this instance, or is disabled in preview. An operator must configure the private App target, household pin and explicitly selected shared data classes."); }
}

export function stateSyncConfiguration(env: Environment) {
  try {
    const github = githubStateConfiguration(env);
    const householdId = env.STATE_SYNC_HOUSEHOLD_ID;
    if (!householdId || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(householdId)) throw new StateSyncConfigurationError();
    const classes = selectedStateClasses((env.STATE_SYNC_CLASSES ?? "").split(",").map((name) => name.trim()));
    return { github, classes, householdId, targetKey: stateTargetKey(github, householdId) };
  } catch { throw new StateSyncConfigurationError(); }
}

export function schedulerAuthorized(request: Request, env: Environment): "authorized" | "disabled" | "unauthorized" {
  return authorizeScheduler(request, env.STATE_SYNC_SCHEDULER_SECRET, env.VERCEL_ENV === "preview");
}
