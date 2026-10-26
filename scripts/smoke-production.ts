import { SmokeConfigError, formatResults, parseSmokeArgs, runSmoke } from "../lib/smoke/production";

try {
  const config = parseSmokeArgs(process.argv.slice(2), process.env);
  const { lines, exitCode } = formatResults(await runSmoke(config, fetch));
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
} catch (error) {
  console.error(`FAIL ${error instanceof SmokeConfigError ? error.message : "Smoke run could not start."}`);
  process.exitCode = 1;
}
