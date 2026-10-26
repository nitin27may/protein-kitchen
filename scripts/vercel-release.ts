import fs from "node:fs";
import { deployedHost, previousProductionDeployment, requireReadyProduction, waitForAlias } from "../lib/deployment/vercel-release";
import { VercelApiError } from "../lib/deployment/vercel-project";

function append(file: string | undefined, line: string): void {
  if (!file) throw new VercelApiError("VERCEL_CONFIG", "GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are required.");
  fs.appendFileSync(file, `${line}\n`);
}

/**
 * `previous` records the id of the production deployment that is live now (job summary).
 * `candidate <deploy.json>` checks the uploaded deployment is READY for production and exports `url` and `id`.
 * `wait-alias <id>` waits until PRODUCTION_ORIGIN points at the promoted deployment.
 */
async function main(): Promise<number> {
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === "previous" && argument === undefined) {
      const id = await previousProductionDeployment(process.env);
      append(process.env.GITHUB_STEP_SUMMARY, `Previous production deployment: ${id ?? "none"}`);
      console.log(`previous ${id ?? "none"}`);
    } else if (command === "candidate" && argument) {
      const host = deployedHost(fs.readFileSync(argument, "utf8"));
      const id = await requireReadyProduction(process.env, host);
      append(process.env.GITHUB_OUTPUT, `url=https://${host}`);
      append(process.env.GITHUB_OUTPUT, `id=${id}`);
      append(process.env.GITHUB_STEP_SUMMARY, `Candidate deployment: ${id} (READY, production target)`);
      console.log(`candidate ${id} READY`);
    } else if (command === "wait-alias" && argument) {
      await waitForAlias(process.env, argument, process.env.PRODUCTION_ORIGIN ?? "");
      console.log("alias ok");
    } else {
      throw new VercelApiError("VERCEL_CONFIG", "Usage: vercel-release previous | candidate <deploy.json> | wait-alias <id>");
    }
    return 0;
  } catch (error) {
    console.error(error instanceof VercelApiError ? error.message : "VERCEL_FAILED: unexpected error; see the job status.");
    return 1;
  }
}
main().then((code) => { process.exitCode = code; });
