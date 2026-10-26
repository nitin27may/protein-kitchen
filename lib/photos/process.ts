import { createHash } from "node:crypto";
import sharp from "sharp";

export const MASTER_PX = 2048;
export const LIBRARY_MASTER_PX = 1280;
export const THUMB_PX = 640;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Refuses decompression bombs: 40 megapixels is more than any phone camera sends after the client resize. */
const MAX_INPUT_PIXELS = 40_000_000;
const ACCEPTED = new Set(["jpeg", "png", "webp"]);

export class PhotoError extends Error {}

export interface ProcessedPhoto {
  master: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  /** sha256 of the master, hex. */
  sha256: string;
}

/**
 * Turns an uploaded image into a location-free WebP master and thumbnail. Orientation is applied first, then every
 * metadata block (EXIF, GPS, ICC, XMP) is dropped by re-encoding without `withMetadata`. Throws PhotoError for anything
 * that is not a JPEG, PNG or WebP of reasonable size. Household photos keep a 2048 px master; library photos pass
 * `LIBRARY_MASTER_PX` (1280 px). The thumbnail is 640 px either way.
 */
export async function processPhoto(input: Uint8Array, opts: { masterPx?: number } = {}): Promise<ProcessedPhoto> {
  const masterPx = opts.masterPx ?? MASTER_PX;
  if (input.byteLength === 0) throw new PhotoError("The file is empty.");
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new PhotoError("The photo is larger than 8 MB.");
  const src = Buffer.from(input);
  let format: string | undefined;
  try {
    format = (await sharp(src, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new PhotoError("That file is not an image the app can read.");
  }
  if (!format || !ACCEPTED.has(format)) throw new PhotoError("Use a JPEG, PNG or WebP photo.");

  const base = () => sharp(src, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate();
  try {
    const master = await base().resize({ width: masterPx, height: masterPx, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const thumb = await base().resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return { master: master.data, thumb, width: master.info.width, height: master.info.height, sha256: createHash("sha256").update(master.data).digest("hex") };
  } catch {
    throw new PhotoError("That photo could not be processed. Try another one.");
  }
}
