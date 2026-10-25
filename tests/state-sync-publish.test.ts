import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import { photoKeys } from "../lib/photos/keys";
import { openPrivateStateRepository, StateGitHubError } from "../lib/sync/github";
import { publishState, statePayload } from "../lib/sync/publish";
import type { StateSnapshot } from "../lib/sync/snapshot";
import { base, fixtureConfiguration as config, fixtureTime, githubFixture } from "./helpers/github-state";

const fixture = githubFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.close());
beforeEach(() => { fixture.reset(); vi.restoreAllMocks(); });
const open = () => openPrivateStateRepository(config, fixture.fetch, () => fixtureTime);
const id = "a".repeat(40);
const uid = "01234567-89ab-4cde-8fab-0123456789ab";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function snapshot(files: Record<string, string> = { "saved-views/synthetic.json": '{"query":"quick=1"}' }, dataClass = "saved-views"): StateSnapshot {
  return {
    revisions: { [dataClass]: 1 },
    bundle: { manifest: { version: 2, tables: { [dataClass]: {
      count: Object.keys(files).length, sha256: digest(Buffer.from(Object.keys(files).sort().map((path) => `${path}\n${files[path]}`).join("\0"))),
    } } }, files },
  };
}
const basicPayload = () => statePayload(snapshot(), createMemoryStore());

describe("state payload privacy, checksums and processed photo boundary", () => {
  it("builds byte-stable, explicitly selected managed files and a checksummed manifest", async () => {
    const payload = await basicPayload();
    expect(payload).toEqual(await basicPayload());
    expect(Object.keys(payload)).toEqual(["protein-kitchen/saved-views/synthetic.json", "protein-kitchen/manifest.json"]);
    const manifest = JSON.parse(Buffer.from(payload["protein-kitchen/manifest.json"]!).toString());
    expect(manifest).toMatchObject({ format: "protein-kitchen-state", version: 1, revisions: { "saved-views": 1 },
      files: { "saved-views/synthetic.json": digest(payload["protein-kitchen/saved-views/synthetic.json"]!) } });
    expect(await statePayload(snapshot({}), createMemoryStore())).toHaveProperty("protein-kitchen/manifest.json");
  });

  it.each(["empty", "personal", "revision", "version", "class-mismatch", "checksum", "count"])("rejects invalid selected snapshots: %s", async (kind) => {
    const input = snapshot();
    if (kind === "empty") { input.revisions = {}; input.bundle.manifest.tables = {}; }
    if (kind === "personal") { input.revisions = { "personal-recipe-feedback": 1 }; }
    if (kind === "revision") input.revisions["saved-views"] = 0;
    if (kind === "version") input.bundle.manifest.version = 1;
    if (kind === "class-mismatch") input.bundle.manifest.tables.extra = { count: 0, sha256: "" };
    if (kind === "checksum") input.bundle.manifest.tables["saved-views"]!.sha256 = "wrong";
    if (kind === "count") input.bundle.manifest.tables["saved-views"]!.count = 5;
    await expect(statePayload(input, createMemoryStore())).rejects.toThrow();
  });

  it.each(["saved-views/../bad.json", "people/profile.json", "saved-views/file.txt", "saved-views/.git/config.json"])(
    "rejects unselected/unsafe payload paths: %s", async (path) => {
      await expect(statePayload(snapshot({ [path]: "{}" }), createMemoryStore())).rejects.toThrow("outside selected");
    },
  );

  it("mirrors both actual processed WebP variants after validating the recorded master checksum", async () => {
    const store = createMemoryStore();
    const keys = photoKeys(uid);
    const master = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#884422" } }).webp().toBuffer();
    const thumb = await sharp(master).resize({ width: 640 }).webp().toBuffer();
    await store.put(keys.master, master, "image/webp"); await store.put(keys.thumb, thumb, "image/webp");
    const source = snapshot({ [`photos/recipes/synthetic/${uid}.json`]: JSON.stringify({ uid, sha256: digest(master) }) }, "photos");
    const payload = await statePayload(source, store);
    expect(payload[`protein-kitchen/blobs/${keys.master}`]).toEqual(new Uint8Array(master));
    expect(payload[`protein-kitchen/blobs/${keys.thumb}`]).toEqual(new Uint8Array(thumb));
    expect(Object.keys(payload)).toHaveLength(4);
  });

  it.each(["not-json", "invalid-uid", "wrong-path", "missing", "wrong-type", "wrong-hash", "raw-jpeg", "oversized-master", "oversized-thumb", "metadata", "icc", "truncated"])(
    "refuses missing, raw or corrupt photos before any remote call: %s", async (kind) => {
      const store = createMemoryStore();
      const keys = photoKeys(uid);
      let pipeline = sharp({ create: { width: kind === "oversized-master" ? 2049 : 20, height: 20, channels: 3, background: "#663311" } });
      if (kind === "metadata") pipeline = pipeline.withExif({ IFD0: { Artist: "Synthetic" } });
      if (kind === "icc") pipeline = pipeline.withIccProfile("srgb");
      let bytes = await (kind === "raw-jpeg" ? pipeline.jpeg() : pipeline.webp()).toBuffer();
      if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 8);
      await store.put(keys.master, bytes, kind === "wrong-type" ? "image/jpeg" : "image/webp");
      const thumb = kind === "oversized-thumb" ? await sharp({ create: { width: 641, height: 20, channels: 3, background: "#663311" } }).webp().toBuffer() : bytes;
      if (kind !== "missing") await store.put(keys.thumb, thumb, "image/webp");
      const metadata = kind === "not-json" ? "SENSITIVE_INVALID_JSON" : JSON.stringify({
        uid: kind === "invalid-uid" ? "bad" : uid, sha256: kind === "wrong-hash" ? "a".repeat(64) : digest(bytes),
      });
      const input = snapshot({ [`photos/recipes/synthetic/${kind === "wrong-path" ? "wrong" : uid}.json`]: metadata }, "photos");
      await expect(statePayload(input, store)).rejects.toThrow();
      expect(fixture.requests).toEqual([]);
    },
  );
});

describe("private state publication over actual synthetic GitHub HTTP", () => {
  it("preserves unmanaged files, commits changed managed files only and skips an identical retry", async () => {
    const repository = await open();
    const original = fixture.head;
    const files = await basicPayload();
    const result = await publishState(repository, files, null);
    expect(result).toEqual({ commit: fixture.head, changed: true });
    expect(fixture.commits.get(result.commit)!.parents).toEqual([{ sha: original }]);
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(Buffer.from(await repository.blob(rows.find((row) => row.path === "README.md")!.sha)).toString()).toBe("Unmanaged synthetic README");
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(await publishState(repository, files, null)).toEqual({ commit: result.commit, changed: false });
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("handles deletions explicitly and leaves unrelated out-of-band files untouched", async () => {
    const repository = await open();
    const first = await publishState(repository, await basicPayload(), null);
    fixture.edit({ "z-unmanaged.txt": "Synthetic outside edit", "a-unmanaged.txt": "Earlier synthetic outside edit" });
    const changed = snapshot({});
    changed.revisions["saved-views"] = 2;
    await publishState(repository, await statePayload(changed, createMemoryStore()), first.commit);
    const changes = fixture.requests.filter((request) => request.path.endsWith("/git/trees") && request.method === "POST").at(-1)!.body!.tree;
    expect(changes).toContainEqual({ path: "protein-kitchen/saved-views/synthetic.json", sha: null, mode: "100644", type: "blob" });
    const rows = fixture.trees.get(fixture.commits.get(fixture.head)!.tree.sha)!;
    expect(rows.find((row) => row.path === "z-unmanaged.txt")).toBeDefined();
    expect(rows.find((row) => row.path.endsWith("synthetic.json"))).toBeUndefined();
  });

  it("does not re-upload unchanged managed blobs", async () => {
    const repository = await open();
    const first = await publishState(repository, await basicPayload(), null);
    const before = fixture.requests.filter((request) => request.path.endsWith("/git/blobs") && request.method === "POST").length;
    const next = snapshot(); next.revisions["saved-views"] = 2;
    await publishState(repository, await statePayload(next, createMemoryStore()), first.commit);
    expect(fixture.requests.filter((request) => request.path.endsWith("/git/blobs") && request.method === "POST")).toHaveLength(before + 1);
  });

  it("refuses out-of-band managed edits without overwriting them or sending content", async () => {
    const repository = await open();
    const first = await publishState(repository, await basicPayload(), null);
    fixture.edit({ "protein-kitchen/saved-views/synthetic.json": "Out-of-band managed edit" });
    const count = fixture.requests.length;
    const next = snapshot({ "saved-views/synthetic.json": "New local edit" });
    await expect(publishState(repository, await statePayload(next, createMemoryStore()), first.commit)).rejects.toThrow("outside this sync");
    expect(fixture.requests.slice(count).every((request) => request.method === "GET")).toBe(true);
    await expect(publishState(repository, await basicPayload(), null)).rejects.toThrow("outside this sync");
  });

  it.each(["root-blob", "symlink", "gitlink", "unsafe"])("refuses unsafe managed tree entries: %s", async (kind) => {
    const rows = [{ path: kind === "root-blob" ? "protein-kitchen" : kind === "unsafe" ? "protein-kitchen/../bad" : "protein-kitchen/a",
      type: kind === "gitlink" ? "commit" as const : "blob" as const, mode: kind === "symlink" ? "120000" : "100644", sha: id }];
    fixture.head = fixture.putCommit(fixture.putTree(rows), []);
    await expect(publishState(await open(), await basicPayload(), null)).rejects.toThrow();
  });

  it("accepts normal managed directory entries", async () => {
    const rows = [{ path: "protein-kitchen", type: "tree" as const, mode: "040000", sha: id },
      { path: "protein-kitchen/saved-views", type: "tree" as const, mode: "040000", sha: id }];
    fixture.head = fixture.putCommit(fixture.putTree(rows), []);
    await expect(publishState(await open(), await basicPayload(), null)).resolves.toMatchObject({ changed: true });
  });

  it("validates managed payload boundaries before remote access", async () => {
    const repository = await open(); const before = fixture.requests.length;
    await expect(publishState(repository, {}, null)).rejects.toThrow("manifest");
    await expect(publishState(repository, { "protein-kitchen/manifest.json": Buffer.from("{}"), "outside": Buffer.from("x") }, null)).rejects.toThrow("unmanaged");
    await expect(publishState(repository, { "protein-kitchen/manifest.json": Buffer.from("{}"), "protein-kitchen/../bad": Buffer.from("x") }, null)).rejects.toThrow("unmanaged");
    expect(fixture.requests).toHaveLength(before);
  });

  it.each(["wrong-upload", "wrong-tree", "lost-unmanaged"])("refuses incorrect remote object confirmation before advancing: %s", async (kind) => {
    const repository = await open();
    if (kind === "wrong-upload") vi.spyOn(repository, "createBlob").mockResolvedValueOnce(id);
    else {
      const create = repository.createTree;
      vi.spyOn(repository, "createTree").mockImplementationOnce(async (base, entries) => {
        const tree = await create(base, entries);
        if (kind === "wrong-tree") fixture.trees.set(tree, fixture.trees.get(tree)!.filter((entry) => !entry.path.endsWith("manifest.json")));
        else fixture.trees.set(tree, fixture.trees.get(tree)!.filter((entry) => entry.path !== "README.md"));
        return tree;
      });
    }
    await expect(publishState(repository, await basicPayload(), null)).rejects.toThrow();
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("reconciles an ambiguous successful branch update without a duplicate commit", async () => {
    const repository = await open();
    fixture.intercept = (request, response, body) => {
      if (request.method !== "PATCH") return false;
      expect(body!.force).toBe(false);
      fixture.head = String(body!.sha);
      response.destroy(); return true;
    };
    const result = await publishState(repository, await basicPayload(), null);
    expect(result).toEqual({ commit: fixture.head, changed: true });
    fixture.intercept = undefined;
    expect(await publishState(repository, await basicPayload(), null)).toEqual({ commit: result.commit, changed: false });
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it.each([409, 422, 503, 401])("surfaces a refused HTTP %s branch update without force or acknowledgement", async (status) => {
    const repository = await open();
    fixture.intercept = (request, response) => {
      if (request.method !== "PATCH") return false;
      fixture.json(response, {}, status); return true;
    };
    await expect(publishState(repository, await basicPayload(), null)).rejects.toMatchObject({ status });
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("does not overwrite a competing head update and retries safely with a fresh base", async () => {
    const repository = await open();
    let raced = false;
    fixture.intercept = (request) => {
      if (request.method === "PATCH" && !raced) { raced = true; fixture.edit({ "outside.txt": "Concurrent synthetic edit" }); }
      return false;
    };
    await expect(publishState(repository, await basicPayload(), null)).rejects.toBeInstanceOf(StateGitHubError);
    await expect(publishState(repository, await basicPayload(), null)).resolves.toMatchObject({ changed: true });
  });

  it("reports a managed edit arriving after a successful update as a conflict", async () => {
    const repository = await open();
    const advance = repository.advance;
    vi.spyOn(repository, "advance").mockImplementationOnce(async (id) => {
      await advance(id); fixture.edit({ "protein-kitchen/manifest.json": "Concurrent managed edit" });
    });
    await expect(publishState(repository, await basicPayload(), null)).rejects.toThrow("outside this sync");
  });

  it("propagates non-HTTP branch failures without pretending they succeeded", async () => {
    const repository = await open();
    vi.spyOn(repository, "advance").mockRejectedValueOnce(new Error("Synthetic unexpected failure"));
    await expect(publishState(repository, await basicPayload(), null)).rejects.toThrow("Synthetic unexpected failure");
  });
});
