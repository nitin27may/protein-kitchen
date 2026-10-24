import { createHash } from "node:crypto";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import { registerBuiltinClasses } from "./builtin";
import { registeredClasses } from "./registry";

export interface BlobCopyReport {
  copied: number;
  /** Keys the source did not have. */
  missing: string[];
  /** Keys whose bytes did not match the recorded sha256; they are not copied. */
  corrupt: string[];
}

/**
 * Copies the bytes every registered class points at from one store to another (a backup, a restore, or the move to the
 * Neon bucket). The text export carries only metadata and sha256; this carries the bytes. Idempotent.
 */
export async function copyHumanBlobs(db: Db, from: BlobStore, to: BlobStore): Promise<BlobCopyReport> {
  registerBuiltinClasses();
  const report: BlobCopyReport = { copied: 0, missing: [], corrupt: [] };
  for (const cls of registeredClasses()) {
    for (const ref of (await cls.blobs?.(db)) ?? []) {
      const blob = await from.get(ref.key);
      if (!blob) { report.missing.push(ref.key); continue; }
      if (ref.sha256 && createHash("sha256").update(blob.bytes).digest("hex") !== ref.sha256) { report.corrupt.push(ref.key); continue; }
      await to.put(ref.key, blob.bytes, blob.contentType);
      report.copied++;
    }
  }
  return report;
}
