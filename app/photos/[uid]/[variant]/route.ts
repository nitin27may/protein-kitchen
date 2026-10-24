import { eq } from "drizzle-orm";
import { getBlobStore } from "@/lib/blob";
import * as s from "@/lib/db/schema";
import { isPhotoUid, photoKeys } from "@/lib/photos/keys";
import { getDb } from "@/lib/server/context";
import { routeAccess } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

/**
 * Serves a photo by uid. The URL is the contract pages use; the bytes come from the BlobStore. A photo whose row is gone
 * is a 404 even if a stray file is left. Authorization is checked on every fetch, including after account changes.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ uid: string; variant: string }> }): Promise<Response> {
  const access = await routeAccess(_req);
  if (access.response) return access.response;
  const { uid, variant } = await params;
  const missing = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  if (!isPhotoUid(uid) || (variant !== "master" && variant !== "thumb")) return missing();
  const [row] = await (await getDb()).select({ id: s.photos.id }).from(s.photos).where(eq(s.photos.uid, uid)).limit(1);
  if (!row) return missing();
  const blob = await getBlobStore().get(photoKeys(uid)[variant]);
  if (!blob) return missing();
  return new Response(Buffer.from(blob.bytes), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
