import { runtimeTarget } from "../lib/db/postgres/runtime-target";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { verifyNonProductionBranch } from "../lib/db/postgres/verify-branch";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["runtime", "migration"].includes(mode!)) {
  throw new Error("Usage: pnpm db:verify:postgres runtime|migration");
}
const target = mode === "runtime" ? runtimeTarget(process.env) : postgresMigrationTarget(process.env);
await verifyNonProductionBranch(target, process.env);
console.log(`Postgres ${mode} target verified for ${target.databaseEnvironment}. No database pool was opened and no configuration was written.`);
