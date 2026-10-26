import { buildRuntimeManifest, VercelApiError, writeRuntimeManifest } from "../lib/deployment/vercel-project";

/** `vercel-env-manifest <out.json>`: names, types and targets of the Vercel project variables; plain values only. */
async function main(): Promise<number> {
  try {
    const file = process.argv[2];
    if (process.argv.length !== 3 || !file) throw new VercelApiError("VERCEL_CONFIG", "Usage: vercel-env-manifest <out.json>");
    const entries = await buildRuntimeManifest(process.env);
    writeRuntimeManifest(file, entries);
    console.log(`manifest written variables=${entries.length}`);
    return 0;
  } catch (error) {
    console.error(error instanceof VercelApiError ? error.message : "VERCEL_FAILED: unexpected error; see the job status.");
    return 1;
  }
}
main().then((code) => { process.exitCode = code; });
