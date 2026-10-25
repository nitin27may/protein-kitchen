import { runtimeTarget } from "../lib/db/postgres/runtime-target";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { neonHttpControlPlane } from "../lib/db/postgres/neon-control-plane";
import { verifyNonProductionBranch } from "../lib/db/postgres/verify-branch";
import { verifyProductionBranch } from "../lib/db/postgres/verify-production";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["runtime", "migration"].includes(mode!)) {
  throw new Error("Usage: pnpm db:verify:postgres runtime|migration");
}
const target = mode === "runtime" ? runtimeTarget(process.env) : postgresMigrationTarget(process.env);
if (target.databaseEnvironment === "production") {
  if (!process.env.NEON_API_KEY) throw new Error("PRODUCTION_NEON_CONFIG_MISSING: production verification requires NEON_API_KEY.");
  await verifyProductionBranch(target, process.env, neonHttpControlPlane(process.env.NEON_API_KEY));
} else {
  await verifyNonProductionBranch(target, process.env);
}
console.log(`Postgres ${mode} target verified for ${target.databaseEnvironment}. No database pool was opened and no configuration was written.`);
