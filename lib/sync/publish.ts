import { createHash } from "node:crypto";
import { z } from "zod";
import type { BlobStore } from "../blob/types";
import { readProcessedPhoto } from "../photos/processed";
import { stableJson } from "../human/util";
import type { GitTreeEntry, PrivateStateRepository } from "./github";
import { StateGitHubError } from "./github";
import { STATE_SYNC_CLASSES, type StateSnapshot } from "./snapshot";

const ROOT = "protein-kitchen/";
const CHECKPOINT = `${ROOT}manifest.json`;
const hash = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest("hex");
const blobSha = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const safePath = (path: string) => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git");
const photo = z.object({ uid: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const prefixes: Record<string, string> = {
  "recipe-feedback": "feedback/", "recipe-links": "links/", "saved-views": "saved-views/",
  photos: "photos/", "photo-decisions": "photo-decisions/",
};

/** Build once outside transactions; only processed and checksum-verified photo bytes may leave storage. */
export async function statePayload(snapshot: StateSnapshot, store: Pick<BlobStore, "get">): Promise<Record<string, Uint8Array>> {
  const classes = Object.keys(snapshot.revisions).sort();
  if (!classes.length || classes.some((name) => !STATE_SYNC_CLASSES.some((allowed) => allowed === name) ||
      !Number.isSafeInteger(snapshot.revisions[name]) || snapshot.revisions[name]! < 1) ||
      snapshot.bundle.manifest.version !== 2 || JSON.stringify(classes) !== JSON.stringify(Object.keys(snapshot.bundle.manifest.tables).sort())) {
    throw new Error("Invalid selected state snapshot.");
  }
  for (const path of Object.keys(snapshot.bundle.files)) {
    if (!safePath(path) || !classes.some((name) => path.startsWith(prefixes[name]!)) || !path.endsWith(".json")) {
      throw new Error("State snapshot contains a file outside selected shared classes.");
    }
  }
  for (const name of classes) {
    const paths = Object.keys(snapshot.bundle.files).filter((path) => path.startsWith(prefixes[name]!)).sort();
    const checksum = hash("sha256", Buffer.from(paths.map((path) => `${path}\n${snapshot.bundle.files[path]}`).join("\0")));
    const table = snapshot.bundle.manifest.tables[name]!;
    if (table.count !== paths.length || table.sha256 !== checksum) throw new Error("Selected state snapshot checksum mismatch.");
  }
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(snapshot.bundle.files)) {
    files[`${ROOT}${path}`] = Buffer.from(content);
    if (path.startsWith("photos/")) {
      let value: unknown;
      try { value = JSON.parse(content); }
      catch { throw new Error("Invalid photo metadata in state snapshot."); }
      const parsed = photo.safeParse(value);
      if (!parsed.success || !path.endsWith(`/${parsed.data.uid}.json`)) throw new Error("Invalid photo metadata in state snapshot.");
      for await (const object of readProcessedPhoto(store, parsed.data.uid, parsed.data.sha256)) {
        files[`${ROOT}blobs/${object.key}`] = object.bytes;
      }
    }
  }
  const sums = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([path, bytes]) => [path.slice(ROOT.length), hash("sha256", bytes)]));
  files[CHECKPOINT] = Buffer.from(stableJson({
    format: "protein-kitchen-state", version: 1, revisions: snapshot.revisions,
    export: snapshot.bundle.manifest, files: sums,
  }));
  return files;
}

function managed(entries: GitTreeEntry[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.path === ROOT.slice(0, -1)) {
      if (entry.type !== "tree" || entry.mode !== "040000") throw new Error("State namespace is not a directory.");
      continue;
    }
    if (!entry.path.startsWith(ROOT)) continue;
    if (!safePath(entry.path)) throw new Error("State repository contains an unsafe managed path.");
    if (entry.type === "tree" && entry.mode === "040000") continue;
    if (entry.type !== "blob" || entry.mode !== "100644") throw new Error("State repository contains unsupported managed entries.");
    files[entry.path] = entry.sha;
  }
  return files;
}

const same = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export class StateSyncConflict extends Error {
  constructor() { super("Private state files changed outside this sync. Review the repository before retrying; no files were overwritten."); }
}

/**
 * expectedCommit is a server-persisted checkpoint, never browser input.
 * No force updates: an upstream race or ambiguous write is safe to retry with the same payload/checkpoint.
 */
export function publicationHashes(files: Readonly<Record<string, Uint8Array>>): Record<string, string> {
  const desired: Record<string, string> = {};
  if (!files[CHECKPOINT]) throw new Error("State payload requires its manifest.");
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(ROOT) || !safePath(path)) throw new Error("State payload contains an unmanaged path.");
    desired[path] = blobSha(bytes);
  }
  return desired;
}

async function publicationBase(repository: PrivateStateRepository, desired: Record<string, string>, expectedCommit: string | null) {
  if (!desired[CHECKPOINT] || Object.entries(desired).some(([path, sha]) => !path.startsWith(ROOT) || !safePath(path) || !/^[0-9a-f]{40}$/.test(sha))) {
    throw new Error("Invalid pending state publication receipt.");
  }
  const head = await repository.head();
  const current = await repository.commit(head);
  const currentTree = await repository.tree(current.tree.sha);
  const currentFiles = managed(currentTree);
  if (same(currentFiles, desired)) return { head, current, currentTree, currentFiles, synchronized: true };
  let baseline: Record<string, string> = {};
  if (expectedCommit !== null) {
    const checkpoint = await repository.commit(expectedCommit);
    baseline = managed(await repository.tree(checkpoint.tree.sha));
  }
  if (!same(currentFiles, baseline)) throw new StateSyncConflict();
  return { head, current, currentTree, currentFiles, synchronized: false };
}

/** Recover an attempted publication from immutable hashes without rereading possibly deleted photo bytes. */
export async function reconcileState(repository: PrivateStateRepository, desired: Record<string, string>, expectedCommit: string | null) {
  const result = await publicationBase(repository, desired, expectedCommit);
  return { commit: result.head, synchronized: result.synchronized };
}

export async function publishState(
  repository: PrivateStateRepository, files: Readonly<Record<string, Uint8Array>>, expectedCommit: string | null,
): Promise<{ commit: string; changed: boolean }> {
  const desired = publicationHashes(files);
  const { head, current, currentTree, currentFiles, synchronized } = await publicationBase(repository, desired, expectedCommit);
  if (synchronized) return { commit: head, changed: false };
  const entries: { path: string; sha: string | null }[] = [];
  for (const path of Object.keys(desired).sort()) {
    if (currentFiles[path] === desired[path]) continue;
    const uploaded = await repository.createBlob(files[path]!);
    if (uploaded !== desired[path]) throw new Error("State repository returned an incorrect uploaded blob id.");
    entries.push({ path, sha: uploaded });
  }
  for (const path of Object.keys(currentFiles).sort()) {
    if (!(path in desired)) entries.push({ path, sha: null });
  }
  const tree = await repository.createTree(current.tree.sha, entries);
  const proposed = await repository.tree(tree);
  const unmanaged = (rows: GitTreeEntry[]) => rows.filter((entry) => entry.path !== ROOT.slice(0, -1) && !entry.path.startsWith(ROOT))
    .sort((a, b) => a.path < b.path ? -1 : 1);
  if (!same(managed(proposed), desired) || JSON.stringify(unmanaged(proposed)) !== JSON.stringify(unmanaged(currentTree))) {
    throw new Error("State repository returned an incorrect proposed tree.");
  }
  const commit = await repository.createCommit(head, tree, "Sync selected Protein Kitchen state");
  try { await repository.advance(commit); }
  catch (error) {
    if (error instanceof StateGitHubError && (error.retryable || error.status === 409 || error.status === 422)) {
      const live = await repository.head();
      const liveCommit = await repository.commit(live);
      if (same(managed(await repository.tree(liveCommit.tree.sha)), desired)) return { commit: live, changed: true };
    }
    throw error;
  }
  const confirmed = await repository.head();
  const confirmedCommit = await repository.commit(confirmed);
  if (!same(managed(await repository.tree(confirmedCommit.tree.sha)), desired)) throw new StateSyncConflict();
  return { commit: confirmed, changed: true };
}
