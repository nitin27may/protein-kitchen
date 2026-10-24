import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { stableJson } from "../human/util";
import { readProcessedPhoto } from "../photos/processed";
import { assertAgeRecipient, BackupError, encryptBackupFile, type DumpSource } from "./process";

export interface EncryptedBackupOptions {
  outputRoot: string;
  recipient: string;
  ageBinary?: string;
  dump(): DumpSource;
}

async function photoReceipt(db: Db) {
  return db.transaction(async (tx) => {
    const photos = await tx.select({ uid: s.photos.uid, sha256: s.photos.sha256 }).from(s.photos).orderBy(s.photos.uid);
    const [marker] = await tx.select({ revision: s.syncState.revision }).from(s.syncState).where(eq(s.syncState.dataClass, "photos"));
    return { photos, revision: marker?.revision ?? 0 };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Local recovery only. No GitHub/vault write, schedule or destructive reset is enabled here. */
export async function createEncryptedBackup(db: Db, store: Pick<BlobStore, "get">, options: EncryptedBackupOptions) {
  assertAgeRecipient(options.recipient);
  if (options.ageBinary !== undefined && !options.ageBinary) throw new Error("Specify a nonempty age executable path or use PATH.");
  const id = randomUUID(), createdAt = new Date().toISOString();
  const root = path.resolve(options.outputRoot), staging = path.join(root, `.pending-${id}`), destination = path.join(root, `backup-${id}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const files: { file: string; sha256: string; size: number }[] = [];
  const contents: { file: string; key: string; sha256: string; size: number }[] = [];
  async function encrypt(input: DumpSource | Uint8Array, file: string, key: string) {
    const receipt = await encryptBackupFile(input, path.join(staging, file), options.recipient, options.ageBinary);
    files.push({ file, ...receipt.ciphertext }); contents.push({ file, key, ...receipt.plaintext });
  }
  try {
    const before = await photoReceipt(db);
    await encrypt(options.dump(), "database.dump.age", "database.dump");
    for (const row of before.photos) {
      for await (const object of readProcessedPhoto(store, row.uid, row.sha256)) {
        await encrypt(object.bytes, `${randomUUID()}.age`, object.key);
      }
    }
    if ((await photoReceipt(db)).revision !== before.revision) throw new BackupError("photos-changed");
    const manifest = Buffer.from(stableJson({ format: "protein-kitchen-recovery", version: 1, id, created_at: createdAt, contents }));
    const receipt = await encryptBackupFile(manifest, path.join(staging, "manifest.json.age"), options.recipient, options.ageBinary);
    files.push({ file: "manifest.json.age", ...receipt.ciphertext });
    await writeFile(path.join(staging, "index.json"), stableJson({
      format: "protein-kitchen-encrypted-backup", version: 1, id, created_at: createdAt, files,
    }), { flag: "wx", mode: 0o600, flush: true });
    await rename(staging, destination);
    return { directory: destination, encryptedFiles: files.length };
  } catch (error) {
    try {
      for (const file of await readdir(staging)) await unlink(path.join(staging, file));
      await rmdir(staging);
    } catch { throw new BackupError("cleanup-failed", error instanceof BackupError ? error.code : "backup-failed"); }
    throw error instanceof BackupError ? error : new BackupError("backup-failed");
  }
}
