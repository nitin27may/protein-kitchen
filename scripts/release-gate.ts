import fs from "node:fs";
import { ghFromCli, GateError, productionGate, rehearsalGate } from "../lib/deployment/release-gate";

/**
 * `release-gate production|rehearsal`. Reads the event from the environment, asks GitHub (gh, GH_TOKEN) and writes
 * `sha=<40 hex>` to $GITHUB_OUTPUT. Messages are stable codes with value-free text.
 */
function main(): number {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || (mode !== "production" && mode !== "rehearsal")) throw new GateError("GATE_CONFIG", "Usage: release-gate production|rehearsal");
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new GateError("GATE_CONFIG", "GITHUB_OUTPUT is required.");
    const gh = ghFromCli(process.env);
    const { sha } = (mode === "production" ? productionGate : rehearsalGate)(process.env, gh);
    fs.appendFileSync(output, `sha=${sha}\n`);
    console.log(`gate ok ${sha.slice(0, 7)}`);
    return 0;
  } catch (error) {
    const message = error instanceof GateError ? error.message : "GATE_FAILED: unexpected error; see the job status.";
    console.error(`::error::${message}`);
    return 1;
  }
}
process.exitCode = main();
