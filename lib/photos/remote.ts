import { createHash } from "node:crypto";
import type { Candidate } from "./candidates";
import { licenceOk } from "./candidates";
import { MAX_UPLOAD_BYTES } from "./process";

/**
 * Hosts a photo may be downloaded from. The URL comes from a data file, so it is treated as untrusted: https only, one
 * of these hosts, redirects followed by hand and checked again, a size cap and a timeout.
 */
export const ALLOWED_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org", "api.openverse.org"]);
const UA = "ProteinKitchen/0.1 (personal meal planner)";
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

/** Downloads an allowlisted image. Throws RemoteError with a plain message on any problem. */
export async function downloadImage(url: string, fetchImpl: Fetch = fetch): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!hostAllowed(current)) throw new RemoteError("That image is not on a site the app downloads from.");
    let res: Response;
    try {
      res = await fetchImpl(current, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
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
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new RemoteError("The image is larger than 8 MB.");
    const reader = res.body?.getReader();
    if (!reader) throw new RemoteError("The image site sent no data.");
    const chunks: Uint8Array[] = [];
    let total = 0;
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
    return Buffer.concat(chunks);
  }
  throw new RemoteError("The image site redirected too many times.");
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Asks the provider again whether the photo is still freely licensed with the same licence, so a file whose licence was
 * changed or removed since the candidate list was made is refused. Returns an error message, or null when it checks out.
 */
export async function recheckLicence(c: Candidate, fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    if (c.provider === "commons") {
      const title = c.key.slice("commons:".length);
      const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", titles: title, prop: "imageinfo", iiprop: "extmetadata" })}`;
      const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return "Could not check the licence just now. Try again.";
      const body = (await res.json()) as { query?: { pages?: Record<string, { imageinfo?: { extmetadata?: { LicenseShortName?: { value?: string } } }[] }> } };
      const page = Object.values(body.query?.pages ?? {})[0];
      const now = page?.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value ?? "";
      if (!licenceOk(now)) return "That photo's licence has changed, so it cannot be used.";
      if (now !== c.licence) return `The licence changed from ${c.licence} to ${now}. Refresh the candidate list.`;
      return null;
    }
    const id = c.key.slice("openverse:".length);
    const res = await fetchImpl(`https://api.openverse.org/v1/images/${encodeURIComponent(id)}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return "Could not check the licence just now. Try again.";
    const body = (await res.json()) as { license?: string };
    return ["cc0", "by", "by-sa"].includes((body.license ?? "").toLowerCase()) ? null : "That photo's licence has changed, so it cannot be used.";
  } catch {
    return "Could not check the licence just now. Try again.";
  }
}
