import type { PostgresTarget } from "./target";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Empty recipe_feedback rows are test scaffolding. Only a loopback, non-production database gets them; remote
 * development branches, rehearsals and production keep the library seed free of per-recipe feedback.
 */
export function shouldInitializeFeedback(target: Pick<PostgresTarget, "connectionString" | "databaseEnvironment">): boolean {
  if (target.databaseEnvironment === "production") return false;
  try {
    return LOOPBACK.includes(new URL(target.connectionString).hostname);
  } catch {
    return false;
  }
}
