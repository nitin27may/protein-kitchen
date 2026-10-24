import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readBackupIndex, readBackupFile } from "./read";
import type { GitTreeEntry, PrivateStateRepository } from "../sync/github";
import { StateGitHubError } from "../sync/github";

const MiB = 1024 * 1024;
const root = "protein-kitchen/vault/";
const blobSha = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sorted = (entries: GitTreeEntry[]) => entries.slice().sort((a, b) => a.path.localeCompare(b.path));

export class VaultError extends Error {
  constructor(readonly code: "artifact-refused" | "conflict" | "verification-failed") {
    super(`Encrypted vault publication failed (${code}). No verified off-machine backup was reported; preserve the trusted local artifact for inspection/retry.`);
  }
}

/** Framing/integrity is not sender authentication: only publish artifacts from a trusted local backup. */
async function vaultPayload(directory: string, trusted: boolean) {
  if (trusted !== true) throw new VaultError("artifact-refused");
  try {
    const folder = path.resolve(directory);
    if (!(await lstat(folder)).isDirectory()) throw new VaultError("artifact-refused");
    const { index } = await readBackupIndex(folder);
    const prefix = `${root}${index.id}/`;
    const files: Record<string, Uint8Array> = { [`${prefix}index.json`]: Buffer.from(JSON.stringify(index)) };
    for (const item of index.files) {
      const bytes = await readBackupFile(path.join(folder, item.file), 65 * MiB);
      if (bytes.byteLength !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256 ||
          !bytes.subarray(0, 22).equals(Buffer.from("age-encryption.org/v1\n")) || bytes.length < 64) throw new VaultError("artifact-refused");
      files[`${prefix}${item.file}`] = bytes;
    }
    return { id: index.id, prefix, files };
  } catch (error) {
    throw error instanceof VaultError ? error : new VaultError("artifact-refused");
  }
}

function artifactEntries(entries: GitTreeEntry[], prefix: string) {
  const ancestors = ["protein-kitchen", "protein-kitchen/vault", prefix.slice(0, -1)];
  if (entries.some((entry) => ancestors.includes(entry.path) && (entry.type !== "tree" || entry.mode !== "040000"))) {
    throw new VaultError("conflict");
  }
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

function matches(entries: GitTreeEntry[], desired: Record<string, string>): boolean {
  return entries.length === Object.keys(desired).length && entries.every((entry) =>
    entry.type === "blob" && entry.mode === "100644" && desired[entry.path] === entry.sha);
}

/** Append-only: no retention pruning, remote deletion, private identity, plaintext dump or force update. */
export async function publishEncryptedVault(
  directory: string, trusted: boolean, openRepository: () => Promise<PrivateStateRepository>,
): Promise<{ id: string; commit: string; changed: boolean }> {
  const { id, prefix, files } = await vaultPayload(directory, trusted);
  const desired = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, blobSha(bytes)]));
  const repository = await openRepository();
  async function inspect() {
    const head = await repository.head();
    const commit = await repository.commit(head);
    const entries = await repository.tree(commit.tree.sha);
    const existing = artifactEntries(entries, prefix);
    if (existing.length && !matches(existing, desired)) throw new VaultError("conflict");
    return { head, commit, entries, present: existing.length > 0 };
  }
  const initial = await inspect();
  if (initial.present) return { id, commit: initial.head, changed: false };
  const updates = [];
  for (const [name, bytes] of Object.entries(files)) {
    const sha = await repository.createBlob(bytes);
    if (sha !== desired[name]) throw new VaultError("verification-failed");
    updates.push({ path: name, sha });
  }
  const tree = await repository.createTree(initial.commit.tree.sha, updates);
  const proposed = await repository.tree(tree);
  const outside = (entries: GitTreeEntry[]) => sorted(entries.filter((entry) =>
    !entry.path.startsWith(prefix) && !["protein-kitchen", "protein-kitchen/vault", prefix.slice(0, -1)].includes(entry.path)));
  if (!matches(artifactEntries(proposed, prefix), desired) ||
      JSON.stringify(outside(proposed)) !== JSON.stringify(outside(initial.entries))) throw new VaultError("verification-failed");
  const commit = await repository.createCommit(initial.head, tree, "Append encrypted Protein Kitchen recovery artifact");
  try { await repository.advance(commit); }
  catch (error) {
    if (error instanceof StateGitHubError && (error.retryable || error.status === 409 || error.status === 422)) {
      const live = await inspect();
      if (live.present) return { id, commit: live.head, changed: true };
    }
    throw error;
  }
  const confirmed = await inspect();
  if (!confirmed.present) throw new VaultError("verification-failed");
  return { id, commit: confirmed.head, changed: true };
}
