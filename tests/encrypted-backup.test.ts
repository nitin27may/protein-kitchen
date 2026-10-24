import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedBackup } from "../lib/backup/create";
import { assertAgeRecipient, BackupError, encryptBackupFile, postgresDump } from "../lib/backup/process";
import { createMemoryStore } from "../lib/blob/memory";
import { photoKeys } from "../lib/photos/keys";
import { readProcessedPhoto } from "../lib/photos/processed";
import { markChanged } from "../lib/human/util";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

const fake = path.resolve("tests/helpers/backup-tool.mjs");
const recipient = `age1${"a".repeat(58)}`;
const syntheticUrl = new URL("postgres://fixture@127.0.0.1:54329/synthetic");
syntheticUrl.password = "PRIVATE_PASSWORD";
const target = { connectionString: syntheticUrl.href, databaseEnvironment: "test" as const, runtimeEnvironment: "test" as const };
let folder: string, h: DbHandle;
beforeEach(async () => {
  await mkdir("backups", { recursive: true });
  folder = await mkdtemp(path.resolve("backups/unit-test-"));
  h = await openDb();
  await chmod(fake, 0o755);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(folder, { recursive: true, force: true }); });
const options = () => ({ outputRoot: folder, recipient, ageBinary: fake, dump: () => postgresDump(target, fake) });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unpackFake = (bytes: Uint8Array) => Buffer.from(bytes).subarray(Buffer.byteLength("FAKE-AGE\n"));

describe("private local recovery artifact boundaries", () => {
  it("writes only opaque encrypted entries, matching checksums, an encrypted manifest and a final atomic directory", async () => {
    const store = createMemoryStore();
    const uid = randomUUID(), keys = photoKeys(uid);
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#884422" } }).webp().toBuffer();
    await store.put(keys.master, bytes, "image/webp"); await store.put(keys.thumb, bytes, "image/webp");
    await h.db.insert(s.photos).values({
      uid, ingredientSlug: "synthetic", origin: "upload", width: 20, height: 20, sha256: digest(bytes),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const result = await createEncryptedBackup(h.db, store, options());
    expect(result.encryptedFiles).toBe(4);
    expect(await readdir(folder)).toEqual([path.basename(result.directory)]);
    const outer = JSON.parse(await readFile(path.join(result.directory, "index.json"), "utf8"));
    expect(outer).toMatchObject({ format: "protein-kitchen-encrypted-backup", version: 1, id: expect.any(String) });
    expect(JSON.stringify(outer)).not.toContain(uid);
    expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
    for (const file of outer.files) {
      const bytes = await readFile(path.join(result.directory, file.file));
      expect(digest(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.size);
      expect((await stat(path.join(result.directory, file.file))).mode & 0o777).toBe(0o600);
    }
    const manifest = JSON.parse(unpackFake(await readFile(path.join(result.directory, "manifest.json.age"))).toString());
    expect(manifest.contents).toHaveLength(3);
    for (const item of manifest.contents) {
      const content = unpackFake(await readFile(path.join(result.directory, item.file)));
      expect(digest(content)).toBe(item.sha256); expect(content.length).toBe(item.size);
    }
    const dump = JSON.parse(unpackFake(await readFile(path.join(result.directory, "database.dump.age"))).toString());
    expect(dump).toMatchObject({ host: "127.0.0.1", port: "54329", database: "synthetic", user: "fixture", ssl: "disable", passfile: "/dev/null" });
    expect(dump.args).not.toContain(target.connectionString);
    expect(dump.rootCert).toBeUndefined();
    expect(JSON.stringify(dump)).not.toContain("PRIVATE_PASSWORD");
  });
  it.each(["", "AGE-SECRET-KEY-1PRIVATE", "age1plugin1" + "a".repeat(58), "passphrase", "--recipient evil"])(
    "refuses a missing/private/plugin/invalid recipient before reading or creating files: %s", async (value) => {
      const dump = vi.fn(options().dump);
      await expect(createEncryptedBackup(h.db, createMemoryStore(), { ...options(), recipient: value, dump })).rejects.toThrow("public recipient");
      expect(dump).not.toHaveBeenCalled(); expect(await readdir(folder)).toEqual([]);
      expect(() => assertAgeRecipient(value)).toThrow();
    },
  );
  it("refuses an explicitly empty encryption executable before starting a dump", async () => {
    const dump = vi.fn(options().dump);
    await expect(createEncryptedBackup(h.db, createMemoryStore(), { ...options(), ageBinary: "", dump })).rejects.toThrow("nonempty");
    expect(dump).not.toHaveBeenCalled();
  });
  it.each(["database", "encryption", "missing-tool", "invalid-tool", "output"])("cleans a partial %s failure without reporting a completed artifact or exposing stderr", async (kind) => {
    await writeFile(path.join(folder, "unrelated.keep"), "preserve");
    const setup = options();
    if (kind === "database") setup.dump = () => postgresDump({ ...target, connectionString: target.connectionString.replace("/synthetic", "/fail") }, fake);
    if (kind === "encryption") setup.ageBinary = process.execPath;
    if (kind === "missing-tool") setup.ageBinary = path.join(folder, "missing");
    if (kind === "invalid-tool") setup.ageBinary = "\0";
    if (kind === "output") setup.dump = () => { throw new Error("PRIVATE_INTERNAL_FAILURE"); };
    try { await createEncryptedBackup(h.db, createMemoryStore(), setup); throw new Error("Unexpected success"); }
    catch (error) {
      expect(error).toBeInstanceOf(BackupError);
      expect(String(error)).not.toMatch(/PRIVATE_|postgres:|AGE-SECRET/);
    }
    expect(await readdir(folder)).toEqual(["unrelated.keep"]);
    expect(await readFile(path.join(folder, "unrelated.keep"), "utf8")).toBe("preserve");
  });
  it("detects a photo add-then-delete revision cycle instead of producing an inconsistent backup", async () => {
    const setup = options();
    setup.dump = () => ({
      stream: Readable.from((async function* () {
        const at = new Date().toISOString();
        await h.db.transaction(async (tx) => { await markChanged(tx, "photos", at); await markChanged(tx, "photos", at); });
        yield Buffer.from("synthetic database snapshot");
      })()), finished: Promise.resolve(), abort() {},
    });
    await expect(createEncryptedBackup(h.db, createMemoryStore(), setup)).rejects.toMatchObject({ code: "photos-changed" });
    expect(await readdir(folder)).toEqual([]);
  });
  it("fails and cleans up when a photo referenced by the dump cannot be read", async () => {
    await h.db.insert(s.photos).values({
      uid: randomUUID(), ingredientSlug: "synthetic", origin: "upload", width: 20, height: 20, sha256: "a".repeat(64),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await expect(createEncryptedBackup(h.db, createMemoryStore(), options())).rejects.toMatchObject({ code: "backup-failed" });
    expect(await readdir(folder)).toEqual([]);
  });
  it("reports both the original failure and failed cleanup, without erasing unrelated output", async () => {
    const setup = options();
    setup.dump = () => {
      const stream = Readable.from((async function* () {
        const [pending] = await readdir(folder);
        await mkdir(path.join(folder, pending!, "unexpected-directory"));
        yield Buffer.from("synthetic");
        throw new BackupError("dump-failed");
      })());
      return { stream, finished: Promise.resolve(), abort() {} };
    };
    await expect(createEncryptedBackup(h.db, createMemoryStore(), setup)).rejects.toThrow("cleanup-failed after dump-failed");
    expect((await readdir(folder)).every((file) => file.startsWith(".pending-"))).toBe(true);
  });
  it("reports a sanitized unknown source failure when its staging cleanup also fails", async () => {
    const setup = options();
    setup.dump = () => {
      mkdirSync(path.join(folder, readdirSync(folder)[0]!, "unexpected-directory"));
      throw new Error("PRIVATE_INTERNAL_FAILURE");
    };
    await expect(createEncryptedBackup(h.db, createMemoryStore(), setup)).rejects.toThrow("cleanup-failed after backup-failed");
  });
});

describe("bounded child processes and checked processed-photo reuse", () => {
  it("refuses target overrides, poolers, production and unsupported libpq parameters before spawn", () => {
    for (const override of [
      { connectionString: "postgres://fixture@127.0.0.1/synthetic?host=other" },
      { connectionString: "postgres://fixture@ep-example-pooler.neon.tech/synthetic", nonProductionHost: "ep-example-pooler.neon.tech" },
      { connectionString: "postgres://fixture@127.0.0.1/synthetic?options=another" },
      { databaseEnvironment: "production" as const, runtimeEnvironment: "production" as const },
    ]) expect(() => postgresDump({ ...target, ...override }, fake)).toThrow();
  });
  it("does not inherit ambient libpq target/service/password-file options", async () => {
    vi.stubEnv("PGHOST", "other.example"); vi.stubEnv("PGSERVICE", "other"); vi.stubEnv("PGOPTIONS", "unsafe");
    const file = path.join(folder, "dump.age");
    await encryptBackupFile(postgresDump({ ...target, connectionString: "postgres://fixture@127.0.0.1/synthetic?sslmode=prefer&channel_binding=require" }, fake), file, recipient, fake);
    const value = JSON.parse(unpackFake(await readFile(file)).toString());
    expect(value).toMatchObject({ host: "127.0.0.1", port: "5432", ssl: "prefer", channelBinding: "require" });
    expect(value.service).toBeUndefined(); expect(value.options).toBeUndefined();
  });
  it("uses verified system TLS roots only for an explicitly reviewed remote development target", async () => {
    const file = path.join(folder, "remote.age");
    await encryptBackupFile(postgresDump({
      ...target, connectionString: "postgres://fixture@ep-synthetic.neon.tech/synthetic",
      nonProductionHost: "ep-synthetic.neon.tech",
    }, fake), file, recipient, fake);
    expect(JSON.parse(unpackFake(await readFile(file)).toString())).toMatchObject({
      host: "ep-synthetic.neon.tech", ssl: "verify-full", rootCert: "system",
    });
  });
  it("preserves an existing destination and aborts its source after encryption setup failure", async () => {
    const file = path.join(folder, "existing.age"); await writeFile(file, "do not overwrite");
    await expect(encryptBackupFile(Buffer.from("private"), file, recipient, fake)).rejects.toMatchObject({ code: "write-failed" });
    expect(await readFile(file, "utf8")).toBe("do not overwrite");
    const abort = vi.fn();
    await expect(encryptBackupFile({ stream: Readable.from(["private"]), finished: Promise.reject(new Error("PRIVATE_SOURCE")), abort }, path.join(folder, "unused.age"), "bad", fake)).rejects.toMatchObject({ code: "encryption-failed" });
    expect(abort).toHaveBeenCalledOnce();
  });
  it("refuses invalid persisted photo identities or checksums before blob reads", async () => {
    const store = { get: vi.fn() };
    for (const [uid, sha] of [["bad", "a".repeat(64)], [randomUUID(), "bad"]]) {
      await expect(readProcessedPhoto(store, uid!, sha!).next()).rejects.toThrow("Invalid");
    }
    expect(store.get).not.toHaveBeenCalled();
  });
});
