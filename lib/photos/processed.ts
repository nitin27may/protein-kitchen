import { createHash } from "node:crypto";
import sharp from "sharp";
import type { BlobStore } from "../blob/types";
import { isPhotoUid, photoKeys } from "./keys";
import { MASTER_PX, THUMB_PX } from "./process";

/** Shared outbound boundary for private sync and encrypted recovery. Never returns raw originals. */
export async function* readProcessedPhoto(store: Pick<BlobStore, "get">, uid: string, sha256: string) {
  if (!isPhotoUid(uid) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid processed-photo receipt.");
  for (const [variant, key] of Object.entries(photoKeys(uid))) {
    const object = await store.get(key);
    if (!object || object.contentType !== "image/webp" ||
        (variant === "master" && createHash("sha256").update(object.bytes).digest("hex") !== sha256)) {
      throw new Error("Processed photo is missing or corrupt. Run photos:check.");
    }
    const image = sharp(object.bytes, { limitInputPixels: MASTER_PX * MASTER_PX, failOn: "error" });
    const metadata = await image.metadata();
    if (metadata.format !== "webp" || metadata.exif || metadata.iptc || metadata.xmp || metadata.icc ||
        !metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > (variant === "master" ? MASTER_PX : THUMB_PX)) {
      throw new Error("Only metadata-free processed WebP photos can be copied.");
    }
    await image.stats();
    yield { key, bytes: object.bytes };
  }
}
