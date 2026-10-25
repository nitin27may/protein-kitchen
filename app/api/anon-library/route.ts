import { getData } from "@/lib/server/context";
import { anonLibrary } from "@/lib/server/anon-library";

/**
 * Public on purpose: the same library content every visitor can already browse, with no household data. The result
 * never varies by visitor, so a shared cache may keep it. The version in the body lets a client detect a stale copy.
 */
export async function GET() {
  const { body, version } = anonLibrary(getData());
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      ETag: `"${version}"`,
    },
  });
}
