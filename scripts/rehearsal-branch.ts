import fs from "node:fs";
import { Client } from "pg";
import { neonAdminFromEnv } from "../lib/deployment/neon-admin";
import { compareHumanCounts, parseCounts, readHumanCounts } from "../lib/deployment/human-counts";
import { createRehearsalBranch, deleteRehearsalBranch, requireRehearsalBranch, requireRehearsalCi } from "../lib/deployment/rehearsal-branch";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { validatePostgresTarget } from "../lib/db/postgres/target";
import { verifyNonProductionBranch } from "../lib/db/postgres/verify-branch";

const USAGE = "Usage: pnpm db:rehearsal create | delete | counts <out.json> | compare <before.json> <after.json>";

/** Prints branch names, ids and counts only. Runs in GitHub Actions and only against a `rehearse-` branch. */
async function main(): Promise<number> {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const env = process.env;
    requireRehearsalCi(env);
    if (command === "create" && rest.length === 0) {
      const github = env.GITHUB_ENV;
      if (!github) throw new Error("USAGE: GITHUB_ENV is required.");
      const result = await createRehearsalBranch(env, neonAdminFromEnv(env), {
        log: (line) => console.log(line),
        appendEnv: (line) => fs.appendFileSync(github, `${line}\n`),
      });
      console.log(`rehearsal ${result.name} ${result.id}`);
    } else if (command === "delete" && rest.length === 0) {
      console.log(`rehearsal ${await deleteRehearsalBranch(env, neonAdminFromEnv(env))}`);
    } else if (command === "counts" && rest.length === 1) {
      await requireRehearsalBranch(env, neonAdminFromEnv(env));
      const target = postgresMigrationTarget(env);
      await verifyNonProductionBranch(target, env);
      const client = new Client({ connectionString: validatePostgresTarget(target).toString(), connectionTimeoutMillis: 10_000, application_name: "protein-kitchen-rehearsal" });
      await client.connect();
      try {
        const counts = await readHumanCounts(client);
        fs.writeFileSync(rest[0]!, `${JSON.stringify(counts, null, 2)}\n`);
        console.log(`counts written tables=${Object.values(counts).filter((n) => n !== null).length}`);
      } finally {
        await client.end().catch(() => undefined);
      }
    } else if (command === "compare" && rest.length === 2) {
      const read = (file: string) => parseCounts(JSON.parse(fs.readFileSync(file, "utf8")));
      const result = compareHumanCounts(read(rest[0]!), read(rest[1]!));
      if (!result.ok) {
        console.error(`COUNTS_LOST tables=${[...result.lost, ...result.dropped].join(",")}`);
        return 1;
      }
      console.log("counts ok");
    } else {
      throw new Error(USAGE);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const known = /^(NEON_ADMIN_[A-Z_]+|PRODUCTION_[A-Z_]+|COUNTS_INVALID|USAGE): /.test(message) || message.startsWith("Usage:");
    console.error(known ? message : "REHEARSAL_FAILED: unexpected error; see the job status.");
    return 1;
  }
}
main().then((code) => { process.exitCode = code; });
