import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getTableName } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedBackup } from "../lib/backup/create";
import { readEncryptedBackup, recoveryTool, RecoveryError } from "../lib/backup/read";
import { isolatedRestoreTarget, restoreEncryptedPostgres } from "../lib/human/postgres-recovery";
import { createMemoryStore } from "../lib/blob/memory";
import { photoKeys } from "../lib/photos/keys";
import * as s from "../lib/db/schema";
import { openDb } from "./helpers/db";

const mock = vi.hoisted(() => ({ query: vi.fn(), photos: vi.fn(), close: vi.fn(), growing: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!mock.growing || typeof args[0] !== "string" || !args[0].endsWith("index.json")) return handle;
      const file = args[0];
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") return async () => {
            const info = await target.stat();
            await fs.appendFile(file, Buffer.alloc(1024 * 1024 + 1)); return info;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
vi.mock("../lib/db/postgres/client", () => ({
  openPostgres: () => ({ pool: { query: mock.query }, db: { select: () => ({ from: mock.photos }) }, close: mock.close }),
}));

const fake = path.resolve("tests/helpers/backup-tool.mjs");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fakeBytes = (value: unknown) => Buffer.from(`FAKE-AGE\n${JSON.stringify(value)}`);
let folder: string, artifact: string, identity: string, uid: string, sha256: string;
const target = () => ({
  connectionString: `postgres://fixture@127.0.0.1/protein_kitchen_restore_${"a".repeat(32)}`,
  databaseEnvironment: "test" as const, runtimeEnvironment: "test" as const,
});
const options = () => ({ target: target(), artifact, identity, photoDirectory: path.join(folder, "restored"), trusted: true, ageBinary: fake, restoreBinary: fake });
const indexPath = () => path.join(artifact, "index.json");
const readIndex = async () => JSON.parse(await readFile(indexPath(), "utf8"));
const readManifest = async () => JSON.parse((await readFile(path.join(artifact, "manifest.json.age"))).subarray(9).toString());
async function changeIndex(edit: (index: Awaited<ReturnType<typeof readIndex>>) => void) {
  const index = await readIndex(); edit(index); await writeFile(indexPath(), JSON.stringify(index));
}
async function replaceCipher(name: string, bytes: Buffer) {
  await writeFile(path.join(artifact, name), bytes);
  await changeIndex((index) => {
    const entry = index.files.find((entry: { file: string }) => entry.file === name);
    entry.size = bytes.length; entry.sha256 = digest(bytes);
  });
}
async function changeManifest(edit: (manifest: Awaited<ReturnType<typeof readManifest>>) => void) {
  const manifest = await readManifest(); edit(manifest);
  await replaceCipher("manifest.json.age", fakeBytes(manifest));
}

beforeEach(async () => {
  await mkdir("backups", { recursive: true }); folder = await mkdtemp(path.resolve("backups/recovery-test-"));
  await chmod(fake, 0o755);
  identity = path.join(folder, "synthetic-identity"); await writeFile(identity, "synthetic fixture, not a key", { mode: 0o600 });
  const h = await openDb();
  const store = createMemoryStore(); uid = randomUUID();
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#884422" } }).webp().toBuffer();
  sha256 = digest(bytes); const keys = photoKeys(uid);
  await store.put(keys.master, bytes, "image/webp"); await store.put(keys.thumb, bytes, "image/webp");
  await h.db.insert(s.photos).values({
    uid, ingredientSlug: "synthetic", origin: "upload", sha256, width: 20, height: 20,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  artifact = (await createEncryptedBackup(h.db, store, {
    outputRoot: folder, recipient: `age1${"a".repeat(58)}`, ageBinary: fake,
    dump: () => ({ stream: Readable.from([Buffer.from("PGDMP synthetic fixture")]), finished: Promise.resolve(), abort() {} }),
  })).directory;
  mock.query.mockImplementation(async (query: string) => query.includes("pg_tables")
    ? { rows: Object.values(s).map((table) => ({ tablename: getTableName(table) })).sort((a, b) => a.tablename.localeCompare(b.tablename)) }
    : { rows: [], rowCount: 0 });
  mock.photos.mockResolvedValue([{ uid, sha256 }]); mock.close.mockResolvedValue(undefined);
});
afterEach(async () => { mock.growing = false; vi.resetAllMocks(); vi.unstubAllEnvs(); await rm(folder, { recursive: true, force: true }); });

describe("trusted, bounded encrypted recovery preflight", () => {
  it("fully authenticates each file before exposing a validated dump and processed photo pair", async () => {
    const result = await readEncryptedBackup(artifact, identity, true, fake);
    expect(result.dump.toString()).toBe("PGDMP synthetic fixture");
    expect(result.photos).toEqual(new Map([[uid, sha256]]));
    expect(result.contents.map((entry) => entry.key).sort()).toEqual(Object.values(photoKeys(uid)).sort());
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("requires explicit trust before reading even a missing artifact", async () => {
    await expect(readEncryptedBackup("missing", "missing", false, fake)).rejects.toMatchObject({ code: "artifact-invalid" });
  });
  it.each(["version", "extra", "duplicate", "missing-manifest", "path", "file-count", "total", "size", "checksum"])(
    "refuses a malformed or inconsistent clear index: %s", async (kind) => {
      await changeIndex((index) => {
        if (kind === "version") index.version = 2;
        if (kind === "extra") index.private = "PRIVATE_SENTINEL";
        if (kind === "duplicate") index.files.push(index.files[0]);
        if (kind === "missing-manifest") index.files = index.files.filter((entry: { file: string }) => entry.file !== "manifest.json.age");
        if (kind === "path") index.files[0].file = "../escape.age";
        if (kind === "file-count") index.files = Array.from({ length: 5003 }, () => index.files[0]);
        if (kind === "total") index.files = [
          ...index.files.map((entry: object) => ({ ...entry, size: 65 * 1024 * 1024 })),
          { ...index.files[0], file: `${randomUUID()}.age`, size: 65 * 1024 * 1024 },
        ];
        if (kind === "size") index.files[0].size++;
        if (kind === "checksum") index.files[0].sha256 = "f".repeat(64);
      });
      await expect(readEncryptedBackup(artifact, identity, true, fake)).rejects.toMatchObject({ code: "artifact-invalid" });
      expect(mock.query).not.toHaveBeenCalled();
    },
  );
  it.each(["id", "time", "duplicate-file", "duplicate-key", "missing", "unknown", "manifest-self", "database-key", "path", "hash", "size", "header", "thumb-only", "photo"])(
    "refuses authenticated but invalid manifest/content: %s", async (kind) => {
      await changeManifest((manifest) => {
        if (kind === "id") manifest.id = randomUUID();
        if (kind === "time") manifest.created_at = "2020-01-01T00:00:00.000Z";
        if (kind === "duplicate-file") manifest.contents[1].file = manifest.contents[0].file;
        if (kind === "duplicate-key") manifest.contents[1].key = manifest.contents[0].key;
        if (kind === "missing") manifest.contents.pop();
        if (kind === "unknown") manifest.contents[1].file = `${randomUUID()}.age`;
        if (kind === "manifest-self") manifest.contents[1].file = "manifest.json.age";
        if (kind === "database-key") [manifest.contents[0].key, manifest.contents[1].key] = [manifest.contents[1].key, manifest.contents[0].key];
        if (kind === "path") manifest.contents[1].key = "../../escape";
        if (kind === "hash") manifest.contents[0].sha256 = "f".repeat(64);
        if (kind === "size") manifest.contents[0].size++;
        if (kind === "thumb-only") manifest.contents[1].key = `photos/${randomUUID()}/thumb.webp`;
      });
      if (["header", "photo"].includes(kind)) {
        const manifest = await readManifest();
        const entry = manifest.contents[kind === "header" ? 0 : 1];
        const value = Buffer.from("PRIVATE_INVALID_CONTENT");
        await replaceCipher(entry.file, Buffer.concat([Buffer.from("FAKE-AGE\n"), value]));
        entry.size = value.length; entry.sha256 = digest(value);
        await changeManifest((value) => { value.contents = manifest.contents; });
      }
      await expect(readEncryptedBackup(artifact, identity, true, fake)).rejects.toBeInstanceOf(RecoveryError);
      expect(mock.query).not.toHaveBeenCalled();
    },
  );
  it.each(["root-symlink", "identity-symlink", "identity-mode", "file-symlink", "directory", "missing", "large-index", "large-file", "json"])(
    "refuses unsafe or unreadable input files: %s", async (kind) => {
      let directory = artifact;
      if (kind === "root-symlink") { directory = path.join(folder, "link"); await symlink(artifact, directory); }
      if (kind === "identity-symlink") { const link = path.join(folder, "key-link"); await symlink(identity, link); identity = link; }
      if (kind === "identity-mode") await chmod(identity, 0o644);
      if (["file-symlink", "directory", "missing"].includes(kind)) {
        await unlink(indexPath());
        if (kind === "file-symlink") await symlink(identity, indexPath());
        if (kind === "directory") await mkdir(indexPath());
      }
      if (kind === "large-index") await truncate(indexPath(), 1024 * 1024 + 1);
      if (kind === "large-file") await truncate(path.join(artifact, "database.dump.age"), 65 * 1024 * 1024 + 1);
      if (kind === "json") await writeFile(indexPath(), "PRIVATE_INVALID_JSON");
      await expect(readEncryptedBackup(directory, identity, true, fake)).rejects.toMatchObject({ code: "artifact-invalid" });
    },
  );
  it("does not expose private tool errors or return partially decrypted data", async () => {
    identity = path.join(folder, "wrong-identity"); await writeFile(identity, "fixture", { mode: 0o600 });
    await expect(readEncryptedBackup(artifact, identity, true, fake)).rejects.toMatchObject({ code: "decryption-failed" });
    await replaceCipher("manifest.json.age", Buffer.from("not a fake authenticated envelope"));
    await expect(readEncryptedBackup(artifact, identity, true, fake)).rejects.toMatchObject({ code: "decryption-failed" });
  });
  it("refuses a file that grows beyond its limit after the initial file stat", async () => {
    mock.growing = true;
    await expect(readEncryptedBackup(artifact, identity, true, fake)).rejects.toMatchObject({ code: "artifact-invalid" });
  });
  it("bounds child stdout and settles missing, invalid and failed owned processes", async () => {
    for (const [binary, args, limit] of [
      [process.execPath, ["-e", "process.stdout.write('PRIVATE_OUTPUT')"], 4],
      [process.execPath, ["-e", "process.stderr.write('PRIVATE_ERROR');process.exit(1)"], 1],
      [path.join(folder, "missing"), [], 1], ["\0", [], 1],
    ] as const) {
      await expect(recoveryTool(binary, [...args], Buffer.from("synthetic"), limit)).rejects.toMatchObject({ code: "tool-failed" });
    }
  });
});

describe("explicit empty isolated destination and owned photo publication", () => {
  it("restores verified data and publishes private photos, then closes its connection", async () => {
    expect(await restoreEncryptedPostgres(options())).toMatchObject({ tables: Object.values(s).length, photos: 1 });
    expect((await lstat(options().photoDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(options().photoDirectory, photoKeys(uid).master))).mode & 0o777).toBe(0o600);
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("uses explicitly controlled PATH defaults when no executable overrides are supplied", async () => {
    await symlink(fake, path.join(folder, "age"));
    await symlink(fake, path.join(folder, "pg_restore"));
    vi.stubEnv("PATH", `${folder}${path.delimiter}${process.env.PATH}`);
    expect(await restoreEncryptedPostgres({ ...options(), ageBinary: undefined, restoreBinary: undefined })).toMatchObject({ photos: 1 });
  });
  it.each([
    "postgres://fixture@127.0.0.1/production",
    "postgres://fixture@127.0.0.1/protein_kitchen_test",
    `postgres://fixture@ep-other.neon.tech/protein_kitchen_restore_${"a".repeat(32)}`,
    `postgres://fixture@127.0.0.1/protein_kitchen_restore_${"A".repeat(32)}`,
  ])("refuses an unreviewed or non-rehearsal destination: %s", async (connectionString) => {
    await expect(restoreEncryptedPostgres({ ...options(), target: { ...target(), connectionString } })).rejects.toThrow();
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("accepts the exact fresh loopback name but not production/poolers", () => {
    expect(isolatedRestoreTarget(target())).toBe(`protein_kitchen_restore_${"a".repeat(32)}`);
    expect(() => isolatedRestoreTarget({ ...target(), runtimeEnvironment: "production", databaseEnvironment: "production" })).toThrow();
  });
  it.each(["objects", "schemas"])("refuses existing destination %s without touching photos", async (kind) => {
    if (kind === "schemas") mock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mock.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    await expect(restoreEncryptedPostgres(options())).rejects.toMatchObject({ code: "destination-refused" });
    expect(await readdir(folder)).not.toContain("restored"); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("never overwrites an existing photo destination or clears a refused database", async () => {
    await mkdir(options().photoDirectory);
    await writeFile(path.join(options().photoDirectory, "unrelated.keep"), "preserve");
    await expect(restoreEncryptedPostgres(options())).rejects.toMatchObject({ code: "destination-refused" });
    expect(await readFile(path.join(options().photoDirectory, "unrelated.keep"), "utf8")).toBe("preserve");
  });
  it("cleans only its reserved/staged photos after a native-tool failure", async () => {
    await expect(restoreEncryptedPostgres({ ...options(), restoreBinary: path.join(folder, "missing") })).rejects.toMatchObject({ code: "restore-failed" });
    expect((await readdir(folder)).some((name) => name.startsWith(".pending-restore") || name === "restored")).toBe(false);
  });
  it.each(["tables", "count", "checksum", "query"])("refuses a post-restore %s mismatch rather than reporting a verified recovery", async (kind) => {
    if (kind === "tables") mock.query.mockImplementation(async (query: string) => query.includes("pg_tables") ? { rows: [] } : { rows: [], rowCount: 0 });
    if (kind === "count") mock.photos.mockResolvedValue([]);
    if (kind === "checksum") mock.photos.mockResolvedValue([{ uid, sha256: "f".repeat(64) }]);
    if (kind === "query") mock.photos.mockRejectedValue(new Error("PRIVATE_QUERY_FAILURE"));
    await expect(restoreEncryptedPostgres(options())).rejects.toMatchObject({ code: "verification-failed" });
    expect((await readdir(folder)).some((name) => name.startsWith(".pending-restore") || name === "restored")).toBe(false);
  });
  it("preserves an external destination write and explicitly reports failed publication cleanup", async () => {
    mock.photos.mockImplementation(async () => {
      await writeFile(path.join(options().photoDirectory, "unrelated.keep"), "preserve");
      return [{ uid, sha256 }];
    });
    await expect(restoreEncryptedPostgres(options())).rejects.toMatchObject({ code: "cleanup-failed" });
    expect(await readFile(path.join(options().photoDirectory, "unrelated.keep"), "utf8")).toBe("preserve");
    expect(mock.close).toHaveBeenCalledOnce();
  });
});
