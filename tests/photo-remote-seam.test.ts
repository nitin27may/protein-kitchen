import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { downloadImage, recheckOpenverse } from "../lib/photos/remote";
import { fixtureFetch, libraryPhotoFetch, remoteTestDir, RemoteSeamError } from "../lib/photos/remote-seam";

const DIR = path.resolve("tests/fixtures/photos");
const E2E = { PHOTO_REMOTE_TEST_DIR: DIR, DATABASE_ENV: "development", NODE_ENV: "development", DATABASE_URL: "postgres://127.0.0.1:5432/protein_kitchen_e2e" };

describe("PHOTO_REMOTE_TEST_DIR guard", () => {
  it("is off when unset or blank", () => {
    expect(remoteTestDir({})).toBeNull();
    expect(remoteTestDir({ PHOTO_REMOTE_TEST_DIR: "  " })).toBeNull();
    expect(libraryPhotoFetch({})).toBe(fetch);
  });
  it("is honoured for the loopback protein_kitchen_e2e database in development or test", () => {
    expect(remoteTestDir(E2E)).toBe(DIR);
    expect(remoteTestDir({ ...E2E, DATABASE_ENV: "test", NODE_ENV: "test", DATABASE_URL: "postgres://localhost/protein_kitchen_e2e" })).toBe(DIR);
    expect(remoteTestDir({ ...E2E, DATABASE_URL: "postgres://[::1]:5432/protein_kitchen_e2e" })).toBe(DIR);
    expect(libraryPhotoFetch(E2E)).not.toBe(fetch);
  });
  it("is honoured for in-process PGlite unit tests (Vitest, no DATABASE_URL)", () => {
    expect(remoteTestDir({ PHOTO_REMOTE_TEST_DIR: DIR, DATABASE_ENV: "test", VITEST: "true" })).toBe(DIR);
  });
  it("throws on Vercel, whatever else is set", () => {
    expect(() => remoteTestDir({ ...E2E, VERCEL: "1" })).toThrow(RemoteSeamError);
    expect(() => remoteTestDir({ ...E2E, VERCEL_ENV: "preview" })).toThrow(/Vercel/);
    expect(() => libraryPhotoFetch({ ...E2E, VERCEL: "1" })).toThrow(RemoteSeamError);
  });
  it("throws outside development or test, and in production", () => {
    for (const env of [{ ...E2E, DATABASE_ENV: "production" }, { ...E2E, DATABASE_ENV: undefined }, { ...E2E, DATABASE_ENV: "staging" }, { ...E2E, NODE_ENV: "production" }]) {
      expect(() => remoteTestDir(env)).toThrow(/development or test/);
    }
  });
  it("throws for any database that is not the loopback protein_kitchen_e2e", () => {
    for (const url of [
      "postgres://db.example.test/protein_kitchen_e2e", "postgres://127.0.0.1/protein_kitchen", "postgres://localhost/protein_kitchen_test",
      "postgres://ep-1.neon.tech/neondb", "not a url", "postgres://127.0.0.1.evil.test/protein_kitchen_e2e",
    ]) expect(() => remoteTestDir({ ...E2E, DATABASE_URL: url }), url).toThrow(RemoteSeamError);
  });
  it("throws without a database URL unless it is a Vitest run", () => {
    expect(() => remoteTestDir({ PHOTO_REMOTE_TEST_DIR: DIR, DATABASE_ENV: "test" })).toThrow(/disposable/);
    expect(() => remoteTestDir({ PHOTO_REMOTE_TEST_DIR: DIR, DATABASE_ENV: "test", VITEST: "false" })).toThrow(/disposable/);
  });
});

describe("fixture directory fetch", () => {
  const fx = fixtureFetch(DIR);

  it("serves committed fixture images through the real downloader (allowlist and content type still apply)", async () => {
    const bytes = await downloadImage("https://upload.wikimedia.org/anything/falafel.jpg", fx);
    expect((await sharp(bytes).metadata()).format).toBe("jpeg");
    await expect(downloadImage("https://evil.example/falafel.jpg", fx)).rejects.toThrow(/not on a site/);
    await expect(downloadImage("https://upload.wikimedia.org/notes.txt", fx)).rejects.toThrow(/did not send an image/);
    await expect(downloadImage("https://upload.wikimedia.org/missing.jpg", fx)).rejects.toThrow(/404/);
    await expect(downloadImage("https://upload.wikimedia.org/.hidden", fx)).rejects.toThrow(/404/);
    await expect(downloadImage("https://upload.wikimedia.org/a/b/..%2F..%2Fetc", fx)).rejects.toThrow(/404/);
    const odd = await fx("https://upload.wikimedia.org/x/tofu.bin");
    expect(odd.status).toBe(404);
  });
  it("answers any image URL from images/default.jpg when that file exists, odd names included, and 404s without it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "seam-default-"));
    try {
      await mkdir(path.join(dir, "images"));
      await writeFile(path.join(dir, "licences.json"), "{}");
      const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).jpeg().toBuffer();
      const bare = fixtureFetch(dir);
      expect((await bare("https://upload.wikimedia.org/x/1280px-Ajwain_(Trachyspermum_ammi).jpg")).status).toBe(404);
      await writeFile(path.join(dir, "images", "default.jpg"), jpeg);
      await writeFile(path.join(dir, "images", "own.jpg"), await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).jpeg().toBuffer());
      const withDefault = fixtureFetch(dir);
      const odd = await downloadImage("https://upload.wikimedia.org/x/1280px-Ajwain_(Trachyspermum_ammi).jpg", withDefault);
      expect((await sharp(odd).metadata()).width).toBe(8);
      const own = await downloadImage("https://upload.wikimedia.org/x/own.jpg", withDefault);
      expect((await sharp(own).metadata()).width).toBe(4);
      expect((await withDefault("https://upload.wikimedia.org/.hidden")).status).toBe(200);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("answers Commons licence queries for several titles and Openverse by id from licences.json", async () => {
    const res = await fx(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: "query", titles: "File:Fixture Falafel.jpg|File:Nope.jpg" })}`);
    const body = (await res.json()) as { query: { pages: Record<string, { title: string; missing?: string; imageinfo?: unknown[] }> } };
    expect(Object.values(body.query.pages).map((p) => [p.title, "missing" in p])).toEqual([["File:Fixture Falafel.jpg", false], ["File:Nope.jpg", true]]);
    expect(await recheckOpenverse({ key: "openverse:fixture-tofu", provider: "openverse" } as never, fx)).toBeNull();
    expect(await recheckOpenverse({ key: "openverse:unknown" } as never, fx)).toMatch(/Try again/);
    expect((await fx("https://commons.wikimedia.org/w/api.php")).status).toBe(200);
  });
});
