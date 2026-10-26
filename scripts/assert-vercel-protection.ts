import { assertStandardProtection, VercelApiError } from "../lib/deployment/vercel-project";

/** Fails unless the Vercel project is on Standard Protection. Prints a stable code only. */
async function main(): Promise<number> {
  try {
    if (process.argv.length !== 2) throw new VercelApiError("VERCEL_CONFIG", "Usage: assert-vercel-protection");
    await assertStandardProtection(process.env);
    console.log("protection standard");
    return 0;
  } catch (error) {
    console.error(error instanceof VercelApiError ? error.message : "VERCEL_FAILED: unexpected error; see the job status.");
    return 1;
  }
}
main().then((code) => { process.exitCode = code; });
