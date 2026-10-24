import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { createFsStore } from "../lib/blob/fs";
import { createMemoryStore } from "../lib/blob/memory";
import type { BlobStore } from "../lib/blob/types";
import { assertBlobKey } from "../lib/blob/types";
import { MASTER_PX, PhotoError, THUMB_PX, processPhoto } from "../lib/photos/process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pk-blob-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function suite(name: string, make: () => BlobStore) {
  describe(`${name} blob store`, () => {
    it("stores, reads, lists and deletes", async () => {
      const s = make();
      await s.put("photos/a/master.webp", new Uint8Array([1, 2, 3]), "image/webp");
      expect(await s.exists("photos/a/master.webp")).toBe(true);
      const got = await s.get("photos/a/master.webp");
      expect([...got!.bytes]).toEqual([1, 2, 3]);
      expect(await s.list()).toEqual(["photos/a/master.webp"]);
      await s.delete("photos/a/master.webp");
      await s.delete("photos/a/master.webp");
      expect(await s.get("photos/a/master.webp")).toBeNull();
      expect(await s.list()).toEqual([]);
    });

    it("refuses keys that could escape the store", async () => {
      const s = make();
      for (const bad of ["../x", "/abs", "a/../b", "A/upper", "a//b", "a\\b", ""]) await expect(s.put(bad, new Uint8Array([1]), "x")).rejects.toThrow();
    });
  });
}

suite("memory", () => createMemoryStore());
suite("filesystem", () => createFsStore(fs.mkdtempSync(path.join(tmp, "s-"))));

describe("assertBlobKey", () => {
  it("accepts nested lower-case keys", () => {
    expect(() => assertBlobKey("photos/0a1b2c/master.webp")).not.toThrow();
  });
});

async function jpegWith(width: number, height: number, exif?: object, rotateExif?: number): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg();
  if (exif) img = img.withExif(exif as never);
  if (rotateExif) img = img.withMetadata({ orientation: rotateExif });
  return img.toBuffer();
}

describe("processPhoto", () => {
  it("returns WebP, capped in size, with no metadata", async () => {
    const input = await jpegWith(3000, 2000, { IFD0: { Copyright: "someone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 39/1 0/1" } });
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processPhoto(input);
    const m = await sharp(out.master).metadata();
    expect(m.format).toBe("webp");
    expect(m.exif).toBeUndefined();
    expect(m.icc).toBeUndefined();
    expect(Math.max(m.width!, m.height!)).toBe(MASTER_PX);
    expect(out.width).toBe(m.width);
    expect(Math.max((await sharp(out.thumb).metadata()).width!, (await sharp(out.thumb).metadata()).height!)).toBe(THUMB_PX);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not enlarge a small photo", async () => {
    const out = await processPhoto(await jpegWith(400, 300));
    expect([out.width, out.height]).toEqual([400, 300]);
  });

  it("applies EXIF orientation before dropping it", async () => {
    // Stored 400x300 with orientation 6 (rotate 90 degrees): it should come out 300x400.
    const out = await processPhoto(await jpegWith(400, 300, undefined, 6));
    expect([out.width, out.height]).toEqual([300, 400]);
  });

  it("rejects empty, oversized, non-image and unsupported files", async () => {
    await expect(processPhoto(new Uint8Array())).rejects.toBeInstanceOf(PhotoError);
    await expect(processPhoto(new Uint8Array(9 * 1024 * 1024))).rejects.toBeInstanceOf(PhotoError);
    await expect(processPhoto(Buffer.from("not an image"))).rejects.toBeInstanceOf(PhotoError);
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(processPhoto(gif)).rejects.toThrow(/JPEG, PNG or WebP/);
  });
});
