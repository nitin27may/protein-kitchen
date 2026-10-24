import { timingSafeEqual } from "node:crypto";
import { githubStateConfiguration } from "./github";
import { stateTargetKey } from "./run";
import { selectedStateClasses } from "./snapshot";

type Environment = Readonly<Record<string, string | undefined>>;
export class StateSyncConfigurationError extends Error {
  constructor() { super("Private state sync is not configured on this instance, or is disabled in preview. An owner must configure the private App target and explicitly selected shared data classes."); }
}

export function stateSyncConfiguration(env: Environment) {
  try {
    const github = githubStateConfiguration(env);
    const classes = selectedStateClasses((env.STATE_SYNC_CLASSES ?? "").split(",").map((name) => name.trim()));
    return { github, classes, targetKey: stateTargetKey(github) };
  } catch { throw new StateSyncConfigurationError(); }
}

export function schedulerAuthorized(request: Request, env: Environment): "authorized" | "disabled" | "unauthorized" {
  const secret = env.STATE_SYNC_SCHEDULER_SECRET;
  if (env.VERCEL_ENV === "preview" || !secret || !/^[a-zA-Z0-9_-]{32,128}$/.test(secret)) return "disabled";
  const received = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (!received || Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return "unauthorized";
  return "authorized";
}
