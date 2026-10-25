import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadData } from "../lib/data/load";
import { libraryVersion } from "../lib/db/library-version";
import { neonHttpControlPlane } from "../lib/db/postgres/neon-control-plane";
import { productionDirectTarget } from "../lib/db/postgres/production-target";
import { validatePostgresTarget } from "../lib/db/postgres/target";
import {
  checkConfiguration, checkNeon, formatResult, loadMigrationArtifacts, parseCheckArguments, requireRemoteFlag,
  runDatabaseChecks, summarise,
} from "../lib/deployment/check-production";
import type { CheckResult } from "../lib/deployment/check-production";

/**
 * Read-only production sanity check. Prints stable codes only: no URL, host, credential or database value, and no raw
 * error text (driver messages can contain connection details). Loads no environment files.
 */
async function main(): Promise<number> {
  const args = parseCheckArguments(process.argv.slice(2));
  const env = process.env;
  const emit = (results: CheckResult[]) => { for (const r of results) console.log(formatResult(r)); };

  const refused = requireRemoteFlag(env, args);
  if (refused) { emit([refused]); console.log(summarise([refused], args.phase)); return 1; }

  const results = checkConfiguration(env);
  if (results.some((r) => r.severity === "fail")) {
    results.push({ check: "remote", severity: "fail", code: "SKIPPED_PREREQUISITE", detail: "config" });
    emit(results); console.log(summarise(results, args.phase)); return 1;
  }

  const plane = neonHttpControlPlane(env.NEON_API_KEY!);
  const neon = await checkNeon(env, plane);
  results.push(neon);
  if (neon.severity === "fail") {
    results.push({ check: "database", severity: "fail", code: "SKIPPED_PREREQUISITE", detail: "neon" });
    emit(results); console.log(summarise(results, args.phase)); return 1;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = loadData(root);
  if (data.issues.length) {
    results.push({ check: "library", severity: "fail", code: "CHECK_ERROR", detail: "local-data-invalid" });
    emit(results); console.log(summarise(results, args.phase)); return 1;
  }
  const client = new Client({
    connectionString: validatePostgresTarget(productionDirectTarget(env)).toString(),
    connectionTimeoutMillis: 10_000, application_name: "protein-kitchen-check",
  });
  try {
    await client.connect();
  } catch {
    results.push({ check: "connect", severity: "fail", code: "CONNECT_FAILED" });
    emit(results); console.log(summarise(results, args.phase)); return 1;
  }
  try {
    results.push(...await runDatabaseChecks({
      client, env, phase: args.phase, plane,
      artifacts: loadMigrationArtifacts(path.join(root, "db", "postgres-migrations")),
      localLibraryVersion: libraryVersion(data),
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
  emit(results);
  console.log(summarise(results, args.phase));
  return results.some((r) => r.severity === "fail") ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, () => {
  console.log("FAIL run CHECK_ERROR");
  process.exitCode = 1;
});
