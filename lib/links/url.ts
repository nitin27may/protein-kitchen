import type { LinkEmbed } from "./types";

/**
 * Link validation. Pure and dependency-free so the same code runs on the server (actions) and in the browser
 * (form hints). The app never fetches a linked page: it stores the URL, the person's own title and a source name.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 80;
export const MAX_SOURCE_LENGTH = 60;
export const MAX_START_SEC = 86_400;

/** Query parameters that only track where a click came from. Everything else is kept. */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "si", "igshid", "mc_cid", "mc_eid", "ref", "feature"]);

const isTracking = (name: string): boolean => name.startsWith("utm_") || TRACKING_PARAMS.has(name);

export type ParsedLink = { url: string; host: string; embed: LinkEmbed | null };
export type ParseResult = { ok: true; value: ParsedLink } | { ok: false; error: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;

/** True for a bare IPv4 or IPv6 host, which also covers every private and loopback range. */
function isIpHost(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".");
}

/**
 * Start time from `t=` or `start=`: whole seconds (90), seconds with a suffix (90s), or hours, minutes and seconds
 * (1m30s, 1h2m3s). Returns null for anything else, or for a value outside 0 to 24 hours.
 */
export function parseStartSeconds(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  let seconds: number;
  if (/^\d+$/.test(text)) {
    seconds = Number(text);
  } else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_START_SEC ? seconds : null;
}

function youtubeEmbed(url: URL): LinkEmbed | null {
  const host = url.hostname;
  let id: string | null = null;
  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/shorts\/([^/]+)\/?$/.exec(url.pathname);
      if (m) id = m[1] ?? null;
    }
  } else if (host === "youtu.be") {
    const m = /^\/([^/]+)\/?$/.exec(url.pathname);
    if (m) id = m[1] ?? null;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const startSec = parseStartSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return {
    provider: "youtube",
    src: `https://www.youtube-nocookie.com/embed/${id}${startSec ? `?start=${startSec}` : ""}`,
    startSec,
  };
}

function vimeoEmbed(url: URL): LinkEmbed | null {
  if (!VIMEO_HOSTS.has(url.hostname)) return null;
  const m = /^\/(\d+)\/?$/.exec(url.pathname);
  const id = m?.[1];
  if (!id || !VIMEO_ID.test(id)) return null;
  const fragment = /^#t=(.+)$/.exec(url.hash);
  const startSec = parseStartSeconds(fragment?.[1] ?? url.searchParams.get("t"));
  return {
    provider: "vimeo",
    src: `https://player.vimeo.com/video/${id}${startSec ? `#t=${startSec}s` : ""}`,
    startSec,
  };
}

/** Checks and normalises a pasted link: https only, no credentials, no local or IP hosts, tracking removed. */
export function parseLinkUrl(input: string): ParseResult {
  const text = (input ?? "").trim();
  if (!text) return { ok: false, error: "Paste a link" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: `That link is too long (limit ${MAX_URL_LENGTH} characters)` };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That does not look like a link. Paste the full address, starting with https://" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use an https link" };
  if (url.username || url.password) return { ok: false, error: "Remove the username and password from the link" };

  const host = url.hostname.toLowerCase();
  if (isIpHost(host) || isLocalHost(host)) return { ok: false, error: "Use a link to a public website, not an IP address or local address" };

  for (const name of [...url.searchParams.keys()]) {
    if (isTracking(name)) url.searchParams.delete(name);
  }
  if (![...url.searchParams.keys()].length) url.search = "";
  if (url.hash === "" || url.hash === "#") url.hash = "";

  const normalised = url.toString();
  if (normalised.length > MAX_URL_LENGTH) return { ok: false, error: `That link is too long (limit ${MAX_URL_LENGTH} characters)` };

  return { ok: true, value: { url: normalised, host, embed: youtubeEmbed(url) ?? vimeoEmbed(url) } };
}

/** Collapses whitespace. Titles are the person's own words, 1 to 80 characters. */
export function normaliseTitle(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, error: "Give the link a short title in your own words" };
  if (value.length > MAX_TITLE_LENGTH) return { ok: false, error: `Keep the title to ${MAX_TITLE_LENGTH} characters or fewer` };
  return { ok: true, value };
}

/** Optional source name such as a channel or site, up to 60 characters. Empty becomes null. */
export function normaliseSource(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: true, value: null };
  if (value.length > MAX_SOURCE_LENGTH) return { ok: false, error: `Keep the source to ${MAX_SOURCE_LENGTH} characters or fewer` };
  return { ok: true, value };
}

/** Optional start time in whole seconds, 0 to 24 hours. null or undefined becomes null. */
export function normaliseStartSec(raw: number | null | undefined): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_START_SEC) return { ok: false, error: "Start time must be a whole number of seconds, up to 24 hours" };
  return { ok: true, value: raw };
}
