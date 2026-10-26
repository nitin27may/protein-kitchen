import { createHash } from "node:crypto";
import type { Candidate } from "./candidates";
import { licenceOk } from "./candidates";
import { MAX_UPLOAD_BYTES } from "./process";

/**
 * Hosts a photo may be downloaded from. The URL comes from a data file, so it is treated as untrusted: https only, one
 * of these hosts, redirects followed by hand and checked again, a size cap and a timeout.
 */
export const ALLOWED_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org", "api.openverse.org"]);
const FALLBACK_UA = "ProteinKitchen/0.1 (personal meal planner)";
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class RemoteError extends Error {}

export const hostAllowed = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

type Fetch = typeof fetch;
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Wikimedia and Openverse ask API clients to name themselves with a way to reach the operator. The contact is the
 * application's own public origin (PRODUCTION_ORIGIN, else BETTER_AUTH_URL), never a person's address.
 */
export function userAgent(env: Environment = process.env): string {
  for (const name of ["PRODUCTION_ORIGIN", "BETTER_AUTH_URL"] as const) {
    try {
      const u = new URL(env[name] ?? "");
      if (u.protocol === "https:" && !u.username && !u.password) return `ProteinKitchen/0.1 (+${u.origin}; library photo review)`;
    } catch { /* try the next source */ }
  }
  return FALLBACK_UA;
}

export interface RemoteOptions {
  /** An outer deadline (for example the whole item). Each request also gets its own timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
}

const requestSignal = (o: RemoteOptions): AbortSignal => {
  const own = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
  return o.signal ? AbortSignal.any([own, o.signal]) : own;
};

/** Downloads an allowlisted image. Throws RemoteError with a plain message on any problem. */
export async function downloadImage(url: string, fetchImpl: Fetch = fetch, opts: RemoteOptions = {}): Promise<Uint8Array> {
  const headers = { "User-Agent": opts.userAgent ?? userAgent() };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!hostAllowed(current)) throw new RemoteError("That image is not on a site the app downloads from.");
    let res: Response;
    try {
      res = await fetchImpl(current, { headers, redirect: "manual", signal: requestSignal(opts) });
    } catch {
      throw new RemoteError("The image site did not answer in time.");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new RemoteError("The image site sent a broken redirect.");
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) throw new RemoteError(`The image site answered ${res.status}.`);
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) throw new RemoteError("The image site did not send an image.");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new RemoteError("The image is larger than 8 MB.");
    const reader = res.body?.getReader();
    if (!reader) throw new RemoteError("The image site sent no data.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          await reader.cancel();
          throw new RemoteError("The image is larger than 8 MB.");
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      throw new RemoteError("The image download was interrupted.");
    }
    return Buffer.concat(chunks);
  }
  throw new RemoteError("The image site redirected too many times.");
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const LICENCE_UNREADABLE = "Could not check the licence just now. Try again.";
const LICENCE_GONE = "That photo's licence has changed, so it cannot be used.";

/** Compares what the provider says now with what the candidate list recorded. Null means it checks out. */
export function commonsLicenceProblem(candidate: Candidate, now: string | undefined): string | null {
  if (!licenceOk(now ?? "")) return LICENCE_GONE;
  if (now !== candidate.licence) return `The licence changed from ${candidate.licence} to ${now}. Refresh the candidate list.`;
  return null;
}

/** Commons file titles per api.php request (the API accepts 50 for a normal client). */
export const COMMONS_TITLES_PER_CALL = 50;

/**
 * One api.php call for up to 50 titles. Returns the current LicenseShortName per requested title ("" when the file is
 * missing or has none). Throws RemoteError when the answer cannot be read.
 */
export async function commonsLicences(titles: readonly string[], fetchImpl: Fetch = fetch, opts: RemoteOptions = {}): Promise<Map<string, string>> {
  const unique = [...new Set(titles)];
  if (unique.length === 0) return new Map();
  if (unique.length > COMMONS_TITLES_PER_CALL) throw new RemoteError("Too many photos to check at once.");
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", titles: unique.join("|"), prop: "imageinfo", iiprop: "extmetadata" })}`;
  let body: { query?: { normalized?: { from: string; to: string }[]; pages?: Record<string, { title?: string; imageinfo?: { extmetadata?: { LicenseShortName?: { value?: string } } }[] }> } };
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": opts.userAgent ?? userAgent() }, signal: requestSignal(opts) });
    if (!res.ok) throw new RemoteError(LICENCE_UNREADABLE);
    body = await res.json();
  } catch {
    throw new RemoteError(LICENCE_UNREADABLE);
  }
  const pages = Object.values(body.query?.pages ?? {});
  const licenceOf = (page: (typeof pages)[number]) => page.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value ?? "";
  // A one-title answer is unambiguous even when the page carries no title.
  if (unique.length === 1 && pages.length === 1) return new Map([[unique[0]!, licenceOf(pages[0]!)]]);
  const byTitle = new Map<string, string>();
  for (const page of pages) if (page.title) byTitle.set(page.title, licenceOf(page));
  const renamed = new Map((body.query?.normalized ?? []).map((n) => [n.from, n.to] as const));
  return new Map(unique.map((title) => [title, byTitle.get(renamed.get(title) ?? title) ?? ""] as const));
}

/** Openverse: one call per id. Returns an error message, or null when the licence is still free. */
export async function recheckOpenverse(candidate: Candidate, fetchImpl: Fetch = fetch, opts: RemoteOptions = {}): Promise<string | null> {
  try {
    const id = candidate.key.slice("openverse:".length);
    const res = await fetchImpl(`https://api.openverse.org/v1/images/${encodeURIComponent(id)}/`, { headers: { "User-Agent": opts.userAgent ?? userAgent() }, signal: requestSignal(opts) });
    if (!res.ok) return LICENCE_UNREADABLE;
    const body = (await res.json()) as { license?: string };
    return ["cc0", "by", "by-sa"].includes((body.license ?? "").toLowerCase()) ? null : LICENCE_GONE;
  } catch {
    return LICENCE_UNREADABLE;
  }
}

/**
 * Asks the provider again whether the photo is still freely licensed with the same licence, so a file whose licence was
 * changed or removed since the candidate list was made is refused. Returns an error message, or null when it checks out.
 */
export async function recheckLicence(c: Candidate, fetchImpl: Fetch = fetch, opts: RemoteOptions = {}): Promise<string | null> {
  if (c.provider !== "commons") return recheckOpenverse(c, fetchImpl, opts);
  const title = c.key.slice("commons:".length);
  try {
    const found = await commonsLicences([title], fetchImpl, opts);
    return commonsLicenceProblem(c, found.get(title));
  } catch (e) {
    return e instanceof RemoteError ? e.message : LICENCE_UNREADABLE;
  }
}
