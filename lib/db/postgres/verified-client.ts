import { openPostgres } from "./client";
import type { PostgresTarget } from "./target";
import { verifyNonProductionBranch } from "./verify-branch";

export async function openVerifiedPostgres(target: PostgresTarget, env: Readonly<Record<string, string | undefined>> = process.env) {
  await verifyNonProductionBranch(target, env);
  return openPostgres(target);
}
