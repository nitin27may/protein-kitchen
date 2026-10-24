import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publishEncryptedVault } from "../lib/backup/vault";
import { openPrivateStateRepository, StateGitHubError } from "../lib/sync/github";
import { fixtureConfiguration, fixtureTime, githubFixture } from "./helpers/github-state";

const fixture = githubFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.close());
let folder: string, id: string;
const open = () => openPrivateStateRepository(fixtureConfiguration, fixture.fetch, () => fixtureTime);
const prefix = () => `protein-kitchen/vault/${id}/`;
const bytes = Buffer.from(`age-encryption.org/v1\n${"Synthetic framing fixture, NOT real cryptography.".repeat(3)}`);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const entry = (file: string) => ({ file, sha256: digest(bytes), size: bytes.length });
const readIndex = async () => JSON.parse(await readFile(path.join(folder, "index.json"), "utf8"));
async function change(edit: (index: Awaited<ReturnType<typeof readIndex>>) => void) {
  const index = await readIndex(); edit(index);
  await writeFile(path.join(folder, "index.json"), JSON.stringify(index));
}
beforeEach(async () => {
  fixture.reset(); vi.restoreAllMocks();
  await mkdir("backups", { recursive: true }); folder = await mkdtemp(path.resolve("backups/vault-test-"));
  id = randomUUID();
  await writeFile(path.join(folder, "index.json"), JSON.stringify({
    format: "protein-kitchen-encrypted-backup", version: 1, id, created_at: "2026-10-24T12:00:00.000Z",
    files: [entry("database.dump.age"), entry("manifest.json.age")],
  }));
  for (const file of ["database.dump.age", "manifest.json.age"]) await writeFile(path.join(folder, file), bytes);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(folder, { recursive: true, force: true }); });

describe("trusted local encrypted artifact preflight", () => {
  it("requires explicit trust before opening even the target transport", async () => {
    const repository = vi.fn(open);
    await expect(publishEncryptedVault("missing", false, repository)).rejects.toMatchObject({ code: "artifact-refused" });
    expect(repository).not.toHaveBeenCalled();
  });
  it.each(["invalid-json", "extra-field", "version", "traversal", "duplicate", "missing-dump", "missing-manifest", "size", "hash", "total", "plaintext", "short", "file-symlink", "index-symlink", "root-symlink", "directory-file", "oversized-index"])(
    "refuses %s before target authentication or uploads", async (kind) => {
      if (kind === "invalid-json") await writeFile(path.join(folder, "index.json"), "PRIVATE_INVALID_JSON");
      if (kind === "extra-field") await change((v) => { v.private = "PRIVATE_PROFILE"; });
      if (kind === "version") await change((v) => { v.version = 9; });
      if (kind === "traversal") await change((v) => { v.files[0].file = "../private.age"; });
      if (kind === "duplicate") await change((v) => { v.files.push(v.files[0]); });
      if (kind === "missing-dump") await change((v) => { v.files[0] = entry(`${randomUUID()}.age`); });
      if (kind === "missing-manifest") await change((v) => { v.files[1] = entry(`${randomUUID()}.age`); });
      if (kind === "size") await change((v) => { v.files[0].size++; });
      if (kind === "hash") await change((v) => { v.files[0].sha256 = "a".repeat(64); });
      if (kind === "total") await change((v) => { v.files = Array.from({ length: 5 }, (_, i) => ({ ...entry(i === 0 ? "database.dump.age" : i === 1 ? "manifest.json.age" : `${randomUUID()}.age`), size: 65 * 1024 * 1024 })); });
      if (kind === "plaintext" || kind === "short") {
        const raw = kind === "short" ? Buffer.from("age-encryption.org/v1\n") : Buffer.from("PRIVATE_PLAINTEXT_DATABASE_CONTENT");
        await writeFile(path.join(folder, "database.dump.age"), raw);
        await change((v) => { v.files[0] = { file: "database.dump.age", sha256: digest(raw), size: raw.length }; });
      }
      if (kind === "file-symlink") {
        await rm(path.join(folder, "database.dump.age"));
        await symlink(path.join(folder, "manifest.json.age"), path.join(folder, "database.dump.age"));
      }
      if (kind === "index-symlink") {
        await writeFile(path.join(folder, "original.json"), await readFile(path.join(folder, "index.json")));
        await rm(path.join(folder, "index.json")); await symlink(path.join(folder, "original.json"), path.join(folder, "index.json"));
      }
      if (kind === "directory-file") {
        await rm(path.join(folder, "database.dump.age")); await mkdir(path.join(folder, "database.dump.age"));
      }
      if (kind === "oversized-index") await writeFile(path.join(folder, "index.json"), Buffer.alloc(1024 * 1024 + 1));
      let source = folder;
      if (kind === "root-symlink") { source = path.join(folder, "link"); await symlink(folder, source); }
      const repository = vi.fn(open);
      await expect(publishEncryptedVault(source, true, repository)).rejects.toMatchObject({ code: "artifact-refused" });
      expect(repository).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);
    },
  );
  it("publishes only canonical allowlisted metadata and encrypted members, never extra local files", async () => {
    await writeFile(path.join(folder, "identity.txt"), "PRIVATE_IDENTITY");
    const index = await readIndex();
    await writeFile(path.join(folder, "index.json"), `{"format":"PRIVATE_DUPLICATE_KEY",${JSON.stringify(index).slice(1)}`);
    await publishEncryptedVault(folder, true, open);
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(rows.filter((r) => r.path.startsWith(prefix()))).toHaveLength(3);
    const clear = fixture.blobs.get(rows.find((r) => r.path === `${prefix()}index.json`)!.sha)!.toString();
    expect(JSON.parse(clear)).toEqual(index);
    expect(clear).not.toContain("PRIVATE");
    expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE_IDENTITY");
  });
});

describe("append-only vault publication over signed synthetic GitHub HTTP", () => {
  it("preserves unrelated data, appends an immutable subtree and skips an identical retry", async () => {
    fixture.edit({ "protein-kitchen/vault/older/index.json": "Older encrypted artifact index", "unrelated/notes.txt": "Unmanaged" });
    const initial = fixture.head;
    const result = await publishEncryptedVault(folder, true, open);
    expect(result).toEqual({ id, commit: fixture.head, changed: true });
    expect(fixture.commits.get(result.commit)!.parents).toEqual([{ sha: initial }]);
    const repeated = await publishEncryptedVault(folder, true, open);
    expect(repeated).toEqual({ ...result, changed: false });
    expect(fixture.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(rows.some((r) => r.path === "README.md")).toBe(true);
    expect(rows.some((r) => r.path === "protein-kitchen/vault/older/index.json")).toBe(true);
    expect(rows.some((r) => r.path === "unrelated/notes.txt")).toBe(true);
  });
  it.each(["changed", "extra", "mode", "type", "ancestor", "ancestor-mode"])("refuses an existing conflicting artifact: %s", async (kind) => {
    await publishEncryptedVault(folder, true, open);
    if (kind === "changed") fixture.edit({ [`${prefix()}database.dump.age`]: "Changed" });
    if (kind === "extra") fixture.edit({ [`${prefix()}extra.txt`]: "Unexpected" });
    if (["ancestor", "ancestor-mode", "mode", "type"].includes(kind)) {
      const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
      if (kind.startsWith("ancestor")) rows.push({ path: "protein-kitchen/vault", type: kind === "ancestor" ? "blob" : "tree", mode: "100644", sha: "a".repeat(40) });
      else if (kind === "type") rows.find((r) => r.path.startsWith(prefix()))!.type = "tree";
      else rows.find((r) => r.path.startsWith(prefix()))!.mode = "100755";
    }
    const before = fixture.head;
    await expect(publishEncryptedVault(folder, true, open)).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.head).toBe(before);
  });
  it("reconciles a lost branch-update response without a second commit", async () => {
    const repository = await open();
    const advance = repository.advance;
    repository.advance = async (id) => { await advance(id); throw new StateGitHubError(null, true); };
    const result = await publishEncryptedVault(folder, true, async () => repository);
    expect(result).toMatchObject({ id, commit: fixture.head, changed: true });
    expect(fixture.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
  it("serializes matching concurrent publications without duplicate artifact contents", async () => {
    const results = await Promise.all([publishEncryptedVault(folder, true, open), publishEncryptedVault(folder, true, open)]);
    expect(results.map((r) => r.id)).toEqual([id, id]);
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(rows.filter((r) => r.path.startsWith(prefix()))).toHaveLength(3);
  });
  it("preserves a different concurrent artifact and retries the original local id without forcing", async () => {
    const repository = await open();
    const advance = repository.advance;
    repository.advance = async (id) => {
      fixture.edit({ "protein-kitchen/vault/concurrent/index.json": "Other concurrent artifact" });
      await advance(id);
    };
    await expect(publishEncryptedVault(folder, true, async () => repository)).rejects.toMatchObject({ status: 422 });
    const result = await publishEncryptedVault(folder, true, open);
    expect(result).toMatchObject({ id, changed: true });
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(rows.some((r) => r.path === "protein-kitchen/vault/concurrent/index.json")).toBe(true);
    expect(rows.filter((r) => r.path.startsWith(prefix()))).toHaveLength(3);
    expect(fixture.requests.filter((r) => r.method === "PATCH").every((r) => r.body?.force === false)).toBe(true);
  });
  it.each(["wrong-blob", "wrong-tree", "outside-tree", "missing-confirmation", "unclassified-advance", "rejected-advance", "conflicting-advance", "forbidden-advance", "head-failure"])(
    "never reports a verified backup on %s", async (kind) => {
      const repository = await open();
      if (kind === "wrong-blob") repository.createBlob = async () => "a".repeat(40);
      if (kind === "wrong-tree" || kind === "outside-tree") {
        const createTree = repository.createTree;
        repository.createTree = async (...args) => {
          const tree = await createTree(...args);
          const rows = fixture.trees.get(tree)!;
          if (kind === "wrong-tree") rows.splice(rows.findIndex((r) => r.path.startsWith(prefix())), 1);
          else rows.find((r) => r.path === "README.md")!.sha = "a".repeat(40);
          return tree;
        };
      }
      if (kind === "missing-confirmation") repository.advance = async () => {};
      if (kind === "unclassified-advance") repository.advance = async () => { throw new Error("Synthetic advance failure"); };
      if (kind === "rejected-advance") repository.advance = async () => { throw new StateGitHubError(422, false); };
      if (kind === "conflicting-advance") repository.advance = async () => { throw new StateGitHubError(409, false); };
      if (kind === "forbidden-advance") repository.advance = async () => { throw new StateGitHubError(401, false); };
      if (kind === "head-failure") repository.head = async () => { throw new StateGitHubError(503, true); };
      await expect(publishEncryptedVault(folder, true, async () => repository)).rejects.toThrow();
    },
  );
});
