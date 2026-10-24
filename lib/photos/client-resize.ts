/** Longest side sent to the server. The server caps at the same size, so nothing is lost by resizing here. */
export const CLIENT_MAX_PX = 2048;

/** Scales (w, h) so the longest side is at most `max`, never enlarging. Pure, for tests. */
export function fitWithin(w: number, h: number, max: number = CLIENT_MAX_PX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Resizes a phone photo in the browser before upload: a 12 MP photo becomes a file of a few hundred KB, which is under
 * the server-action body limit and quick on mobile data. Orientation is applied by the browser (`from-image`). Encodes as
 * JPEG because Safari cannot reliably encode WebP; the server converts to WebP and drops all metadata. Throws if the
 * browser cannot read the file (for example an unsupported HEIC).
 */
export async function resizeForUpload(file: File, max: number = CLIENT_MAX_PX): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("Could not encode the photo");
    return blob;
  } finally {
    bitmap.close();
  }
}
