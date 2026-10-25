import path from "node:path";
import { getBlobStore } from "../lib/blob";
import { createEncryptedBackup } from "../lib/backup/create";
import { assertAgeRecipient, BackupError, postgresDump } from "../lib/backup/process";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";

async function main() {
  if (process.env.VERCEL || process.env.VERCEL_ENV) throw new Error("Run encrypted backup on an approved local/runner host, never a Vercel request or preview.");
  const recipient = process.env.BACKUP_AGE_RECIPIENT;
  assertAgeRecipient(recipient ?? "");
  const target = postgresMigrationTarget(process.env);
  const handle = await openVerifiedPostgres(target, process.env);
  try {
    const result = await createEncryptedBackup(handle.db, getBlobStore(), {
      recipient: recipient!, outputRoot: process.env.BACKUP_OUTPUT_DIR || path.resolve("backups"),
      ageBinary: process.env.AGE_BIN || undefined,
      dump: () => postgresDump(target, process.env.PG_DUMP_BIN || undefined),
    });
    console.log(`Encrypted local recovery artifact written: ${path.basename(result.directory)} (${result.encryptedFiles} encrypted files).`);
    console.log("This is not an off-machine backup. Verify a trusted isolated restore before relying on it.");
  } finally { await handle.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof BackupError ? error.message : "Encrypted backup could not start. Check explicit dev/test direct-target configuration, public recipient and local tools; no remote publication occurred.");
  process.exitCode = 1;
});
