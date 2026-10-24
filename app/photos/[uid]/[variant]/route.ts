import { eq } from "drizzle-orm";
import { getBlobStore } from "@/lib/blob";
import * as s from "@/lib/db/schema";
import { isPhotoUid, photoKeys } from "@/lib/photos/keys";
import { getDb } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/**
 * Serves a photo by uid. The URL is the contract pages use; the bytes come from the BlobStore. A photo whose row is gone
 * is a 404 even if a stray file is left. The uid changes with every new photo, so a response never changes: cache it hard.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ uid: string; variant: string }> }): Promise<Response> {
  const { uid, variant } = await params;
  if (!isPhotoUid(uid) || (variant !== "master" && variant !== "thumb")) return new Response("Not found", { status: 404 });
  const [row] = await (await getDb()).select({ id: s.photos.id }).from(s.photos).where(eq(s.photos.uid, uid)).limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const blob = await getBlobStore().get(photoKeys(uid)[variant]);
  if (!blob) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(blob.bytes), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
