import { requireProductionCiContext } from "../lib/db/postgres/production-guard";
import { neonAdminFromEnv } from "../lib/deployment/neon-admin";
import { createPreDeploySnapshot } from "../lib/deployment/neon-snapshot";

/** Prints the snapshot branch name and id only. Errors are stable codes with value-free text. */
async function main(): Promise<number> {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: pnpm db:snapshot:production");
    requireProductionCiContext(process.env);
    const result = await createPreDeploySnapshot(process.env, neonAdminFromEnv(process.env));
    console.log(`snapshot ${result.name} ${result.id}`);
    return 0;
  } catch (error) {
    // Only our own value-free errors are printed; anything else could carry driver or network detail.
    const known = error instanceof Error && /^(NEON_ADMIN_[A-Z_]+|PRODUCTION_[A-Z_]+): /.test(error.message);
    console.error(known ? (error as Error).message : "SNAPSHOT_FAILED: unexpected error; see the job status.");
    return 1;
  }
}
main().then((code) => { process.exitCode = code; });
