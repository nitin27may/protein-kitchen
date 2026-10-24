import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { createMemoryStore } from "../blob/memory";
import { readProcessedPhoto } from "../photos/processed";

const MiB = 1024 * 1024;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const file = z.string().regex(new RegExp(`^(?:database\\.dump|manifest\\.json|${uuid})\\.age$`));
const key = z.string().regex(new RegExp(`^(?:database\\.dump|photos/${uuid}/(?:master|thumb)\\.webp)$`));
const receipt = z.object({ file, sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive().max(65 * MiB) }).strict();
const indexSchema = z.object({
  format: z.literal("protein-kitchen-encrypted-backup"), version: z.literal(1), id: z.string().uuid(),
  created_at: z.string().datetime(), files: z.array(receipt).min(2).max(5002),
}).strict();
const manifestSchema = z.object({
  format: z.literal("protein-kitchen-recovery"), version: z.literal(1), id: z.string().uuid(),
  created_at: z.string().datetime(), contents: z.array(receipt.extend({ key }).strict()).min(1).max(5001),
}).strict();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class RecoveryError extends Error {
  constructor(readonly code: "artifact-invalid" | "decryption-failed" | "tool-failed" | "destination-refused" | "restore-failed" | "verification-failed" | "cleanup-failed") {
    super(`Isolated recovery failed (${code}). No verified recovery was reported. The destination may contain unverified restored data; inspect or discard it and retry only with a new empty destination.`);
  }
}

/** Bounded owned processes; decrypted output and tool stderr never enter an error or log. */
export async function recoveryTool(command: string, args: string[], input: Uint8Array, limit: number, env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, LANG: "C", NODE_ENV: process.env.NODE_ENV,
}): Promise<Buffer> {
  try {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000, killSignal: "SIGKILL" });
    child.stderr.resume();
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new RecoveryError("tool-failed")));
      child.once("close", (code) => code === 0 ? resolve() : reject(new RecoveryError("tool-failed")));
    });
    const output = (async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > limit) throw new RecoveryError("tool-failed");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    })();
    const tasks = [closed, pipeline(Readable.from([input]), child.stdin), output];
    try { await Promise.all(tasks); return await output; }
    catch {
      child.kill("SIGKILL");
      await Promise.allSettled(tasks);
      throw new RecoveryError("tool-failed");
    }
  } catch { throw new RecoveryError("tool-failed"); }
}

async function boundedFile(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new RecoveryError("artifact-invalid");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new RecoveryError("artifact-invalid");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

export async function readEncryptedBackup(directory: string, identity: string, trusted: boolean, age = "age") {
  if (trusted !== true) throw new RecoveryError("artifact-invalid");
  try {
    const root = path.resolve(directory), identityPath = path.resolve(identity);
    const keyInfo = await lstat(identityPath), rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || !keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) throw new RecoveryError("artifact-invalid");
    const index = indexSchema.parse(JSON.parse((await boundedFile(path.join(root, "index.json"), MiB)).toString()));
    const names = new Map(index.files.map((entry) => [entry.file, entry]));
    if (names.size !== index.files.length || !names.has("manifest.json.age") || !names.has("database.dump.age") ||
        index.files.reduce((size, entry) => size + entry.size, 0) > 256 * MiB) throw new RecoveryError("artifact-invalid");
    async function decrypt(item: z.infer<typeof receipt>, limit: number) {
      const bytes = await boundedFile(path.join(root, item.file), 65 * MiB);
      if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new RecoveryError("artifact-invalid");
      try { return await recoveryTool(age, ["--decrypt", "--identity", identityPath], bytes, limit); }
      catch { throw new RecoveryError("decryption-failed"); }
    }
    const manifest = manifestSchema.parse(JSON.parse((await decrypt(names.get("manifest.json.age")!, 4 * MiB)).toString()));
    if (manifest.id !== index.id || manifest.created_at !== index.created_at ||
        new Set(manifest.contents.map((entry) => entry.file)).size !== manifest.contents.length ||
        new Set(manifest.contents.map((entry) => entry.key)).size !== manifest.contents.length ||
        manifest.contents.length + 1 !== names.size ||
        manifest.contents.some((entry) => entry.file === "manifest.json.age" || !names.has(entry.file) ||
          (entry.key === "database.dump") !== (entry.file === "database.dump.age"))) throw new RecoveryError("artifact-invalid");
    const contents = [];
    const store = createMemoryStore();
    for (const entry of manifest.contents) {
      const bytes = await decrypt(names.get(entry.file)!, 64 * MiB);
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new RecoveryError("artifact-invalid");
      contents.push({ key: entry.key, bytes, sha256: entry.sha256 });
      if (entry.key !== "database.dump") await store.put(entry.key, bytes, "image/webp");
    }
    const dump = contents.find((entry) => entry.key === "database.dump");
    if (!dump || dump.bytes.subarray(0, 5).toString() !== "PGDMP") throw new RecoveryError("artifact-invalid");
    const photos = new Map<string, string>();
    for (const entry of contents.filter((entry) => entry.key.endsWith("/master.webp"))) {
      const uid = entry.key.split("/")[1]!;
      for await (const object of readProcessedPhoto(store, uid, entry.sha256)) void object;
      photos.set(uid, entry.sha256);
    }
    if (photos.size * 2 + 1 !== contents.length) throw new RecoveryError("artifact-invalid");
    return { id: index.id, dump: dump.bytes, contents: contents.filter((entry) => entry.key !== "database.dump"), photos };
  } catch (error) { throw error instanceof RecoveryError ? error : new RecoveryError("artifact-invalid"); }
}
