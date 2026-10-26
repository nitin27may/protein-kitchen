import { readFile } from "node:fs/promises";
import path from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

export class RemoteSeamError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONTENT_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".txt": "text/plain" };

/**
 * Test seam. When PHOTO_REMOTE_TEST_DIR is set, photo downloads and licence checks read a fixture directory instead of
 * the network. It is honoured only for the disposable local browser database (loopback protein_kitchen_e2e) or an
 * in-process unit test (Vitest, no DATABASE_URL), never on Vercel, never in production. Any other combination throws,
 * so a stray variable cannot silently change where photos come from. The deployment check also forbids the variable.
 */
export function remoteTestDir(env: Environment): string | null {
  const dir = env.PHOTO_REMOTE_TEST_DIR?.trim();
  if (!dir) return null;
  if (env.VERCEL || env.VERCEL_ENV) throw new RemoteSeamError("The photo test directory is not available on Vercel.");
  if (env.NODE_ENV === "production" || (env.DATABASE_ENV !== "development" && env.DATABASE_ENV !== "test")) {
    throw new RemoteSeamError("The photo test directory needs a development or test environment.");
  }
  const url = env.DATABASE_URL?.trim();
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new RemoteSeamError("The photo test directory needs the disposable local database."); }
    if (!LOOPBACK.has(parsed.hostname) || parsed.pathname !== "/protein_kitchen_e2e") {
      throw new RemoteSeamError("The photo test directory needs the disposable loopback protein_kitchen_e2e database.");
    }
  } else if (env.VITEST !== "true") {
    throw new RemoteSeamError("The photo test directory needs the disposable local database.");
  }
  return path.resolve(dir);
}

const DEFAULT_IMAGE = "default.jpg";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fetch that serves the fixture directory: `licences.json` maps a candidate key to the licence text the "provider"
 * reports ("commons:File:A.jpg": "CC BY-SA 4.0", "openverse:id": "by"), and image URLs are answered from `images/<last
 * path segment>`. Anything else is a 404, and the allowlist in downloadImage still runs first.
 */
export function fixtureFetch(dir: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    const licences = async (): Promise<Record<string, string>> => JSON.parse(await readFile(path.join(dir, "licences.json"), "utf8")) as Record<string, string>;
    if (url.hostname === "commons.wikimedia.org" && url.pathname === "/w/api.php") {
      const known = await licences();
      const pages: Record<string, unknown> = {};
      (url.searchParams.get("titles") ?? "").split("|").filter(Boolean).forEach((title, i) => {
        const licence = known[`commons:${title}`];
        pages[String(i + 1)] = licence === undefined ? { title, missing: "" } : { title, imageinfo: [{ extmetadata: { LicenseShortName: { value: licence } } }] };
      });
      return json({ query: { pages } });
    }
    const openverse = /^\/v1\/images\/([^/]+)\/$/.exec(url.pathname);
    if (url.hostname === "api.openverse.org" && openverse) {
      const licence = (await licences())[`openverse:${decodeURIComponent(openverse[1]!)}`];
      return licence === undefined ? json({}, 404) : json({ license: licence });
    }
    const name = path.basename(url.pathname);
    const safe = /^[\w.-]+$/.test(name) && !name.startsWith(".");
    // `images/default.jpg` answers any image URL that has no file of its own, so a browser test can approve real candidate
    // entries (whose URLs carry odd characters) without one fixture file each. Without that file the answer stays 404.
    for (const file of safe ? [name, DEFAULT_IMAGE] : [DEFAULT_IMAGE]) {
      try {
        const bytes = await readFile(path.join(dir, "images", file));
        return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" } });
      } catch { /* try the next name */ }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** The fetch the library photo approval uses: the fixture directory when the guarded seam is on, else the real one. */
export function libraryPhotoFetch(env: Environment = process.env): typeof fetch {
  const dir = remoteTestDir(env);
  return dir ? fixtureFetch(dir) : fetch;
}
