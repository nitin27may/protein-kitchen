import { RecoveryError } from "../lib/backup/read";
import { restoreEncryptedPostgres } from "../lib/human/postgres-recovery";

async function main() {
  const [artifact, identity, photoDirectory, trust, ...extra] = process.argv.slice(2);
  const environment = process.env.DATABASE_ENV;
  if (process.env.VERCEL || process.env.VERCEL_ENV || !artifact || !identity || !photoDirectory ||
      trust !== "--trust-artifact" || extra.length || !process.env.RESTORE_DATABASE_URL ||
      (environment !== "development" && environment !== "test")) throw new RecoveryError("destination-refused");
  const result = await restoreEncryptedPostgres({
    target: { connectionString: process.env.RESTORE_DATABASE_URL, runtimeEnvironment: environment, databaseEnvironment: environment },
    artifact, identity, photoDirectory, trusted: true,
    ageBinary: process.env.AGE_BIN || undefined, restoreBinary: process.env.PG_RESTORE_BIN || undefined,
  });
  console.log(`Isolated recovery verified: ${result.id} (${result.tables} tables, ${result.photos} photos).`);
  console.log("Keep this local rehearsal private. Off-machine vault recovery and destructive resets remain disabled.");
}
main().catch((error: unknown) => {
  console.error(error instanceof RecoveryError ? error.message : new RecoveryError("verification-failed").message);
  process.exitCode = 1;
});
