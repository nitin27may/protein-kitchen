import { eq } from "drizzle-orm";
import { getBlobStore } from "@/lib/blob";
import * as s from "@/lib/db/schema";
import { isPhotoUid, libraryPhotoKeys } from "@/lib/photos/keys";
import { getDb } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const NOT_FOUND = { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } as const;

/**
 * Public on purpose: an approved library photo is the same for every visitor and carries no household data. This
 * handler reads no login state, cookie or request header, so a shared cache can keep the answer. A uid without a row is a
 * 404 even if a stray file is left. The household route (/photos/<uid>/<variant>) stays private and uncached.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ uid: string; variant: string }> }): Promise<Response> {
  const { uid, variant } = await params;
  if (!isPhotoUid(uid) || (variant !== "master" && variant !== "thumb")) return new Response("Not found", { status: 404, headers: NOT_FOUND });
  let row: { sha256: string } | undefined;
  let blob: Awaited<ReturnType<ReturnType<typeof getBlobStore>["get"]>>;
  try {
    [row] = await (await getDb()).select({ sha256: s.libraryPhotos.sha256 }).from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, uid)).limit(1);
    blob = row ? await getBlobStore().get(libraryPhotoKeys(uid)[variant]) : null;
  } catch {
    console.error("LIBRARY_PHOTO_UNAVAILABLE");
    return new Response("Photo unavailable", { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  if (!row || !blob) return new Response("Not found", { status: 404, headers: NOT_FOUND });
  return new Response(Buffer.from(blob.bytes), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
      "CDN-Cache-Control": "public, max-age=2592000, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      ETag: `"${row.sha256}${variant === "thumb" ? "-thumb" : ""}"`,
    },
  });
}
