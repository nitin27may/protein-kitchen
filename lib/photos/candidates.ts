import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PROVIDERS = ["commons", "openverse"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** CC0, public domain, CC BY and CC BY-SA only. Anything else (NC, ND, unknown) is never offered. */
const OK_LICENCE = /^(cc0|public domain|pd\b|cc[ -]by(-sa)?[ -][\d.]+)/i;
export const licenceOk = (licence: string): boolean => OK_LICENCE.test(licence.trim());

/** A candidate needs credit shown next to it unless it is CC0 or public domain. */
export const needsCredit = (licence: string): boolean => !/^(cc0|public domain|pd\b)/i.test(licence.trim());

export const CandidateSchema = z.object({
  /** `provider:id`, stable across re-runs. Commons: `commons:File:Name.jpg`. Openverse: `openverse:<uuid>`. */
  key: z.string().regex(/^(commons|openverse):.+/),
  provider: z.enum(PROVIDERS),
  title: z.string().min(1),
  author: z.string().min(1),
  licence: z.string().refine(licenceOk, "licence must be CC0, public domain, CC BY or CC BY-SA"),
  licence_url: z.string().url().nullable(),
  /** The page a person can open to check the photo and its licence. */
  source_url: z.string().url(),
  /** What the review page shows and what approval downloads. Host must be on the allowlist (lib/photos/remote.ts). */
  image_url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

const SubjectMap = z.record(z.string().min(1), z.array(CandidateSchema).max(6));
export const CandidateFileSchema = z.object({ recipes: SubjectMap, ingredients: SubjectMap });
export type CandidateFile = z.infer<typeof CandidateFileSchema>;

export const candidatesPath = (root: string): string => path.join(root, "data", "photo-candidates.json");

export function loadCandidates(root: string): CandidateFile {
  const file = candidatesPath(root);
  if (!fs.existsSync(file)) return { recipes: {}, ingredients: {} };
  return CandidateFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

interface CommonsPage {
  title?: string;
  imageinfo?: { thumburl?: string; url?: string; width?: number; height?: number; descriptionurl?: string; mime?: string; extmetadata?: Record<string, { value?: string } | undefined> }[];
}

/** One Commons search hit (generator=search with imageinfo) to a candidate, or null if it is not a usable, freely licensed photo. */
export function parseCommonsPage(page: CommonsPage): Candidate | null {
  const info = page.imageinfo?.[0];
  if (!page.title || !info) return null;
  if (!["image/jpeg", "image/png", "image/webp"].includes(info.mime ?? "")) return null;
  const meta = info.extmetadata ?? {};
  const licence = meta.LicenseShortName?.value ?? "";
  if (!licenceOk(licence)) return null;
  const imageUrl = info.thumburl ?? info.url;
  if (!imageUrl || !info.width || !info.height || !info.descriptionurl) return null;
  if (Math.max(info.width, info.height) < 600) return null;
  const parsed = CandidateSchema.safeParse({
    key: `commons:${page.title}`,
    provider: "commons",
    title: page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "),
    author: stripHtml(meta.Artist?.value ?? "") || "Unknown author",
    licence,
    licence_url: meta.LicenseUrl?.value && /^https:\/\//.test(meta.LicenseUrl.value) ? meta.LicenseUrl.value : null,
    source_url: info.descriptionurl,
    image_url: imageUrl,
    width: info.width,
    height: info.height,
  });
  return parsed.success ? parsed.data : null;
}

interface OpenverseResult {
  id?: string;
  title?: string | null;
  creator?: string | null;
  license?: string;
  license_version?: string | null;
  license_url?: string | null;
  foreign_landing_url?: string | null;
  width?: number | null;
  height?: number | null;
}

/** An Openverse result to a candidate. Only CC0, BY and BY-SA are accepted, and the image is fetched through Openverse's own thumbnail endpoint. */
export function parseOpenverseResult(r: OpenverseResult): Candidate | null {
  if (!r.id || !r.license || !r.foreign_landing_url) return null;
  const lic = r.license.toLowerCase();
  if (!["cc0", "by", "by-sa"].includes(lic)) return null;
  const licence = lic === "cc0" ? "CC0 1.0" : `CC ${lic.toUpperCase()} ${r.license_version ?? ""}`.trim();
  if (!r.width || !r.height || Math.max(r.width, r.height) < 600) return null;
  const parsed = CandidateSchema.safeParse({
    key: `openverse:${r.id}`,
    provider: "openverse",
    title: (r.title ?? "").trim() || "Untitled",
    author: (r.creator ?? "").trim() || "Unknown author",
    licence,
    licence_url: r.license_url && /^https:\/\//.test(r.license_url) ? r.license_url : null,
    source_url: r.foreign_landing_url,
    image_url: `https://api.openverse.org/v1/images/${r.id}/thumb/`,
    width: r.width,
    height: r.height,
  });
  return parsed.success ? parsed.data : null;
}

/** Keeps the first `max` candidates, one per key and one per landing page. */
export function dedupeCandidates(list: readonly Candidate[], max = 6): Candidate[] {
  const keys = new Set<string>();
  const pages = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    if (keys.has(c.key) || pages.has(c.source_url)) continue;
    keys.add(c.key);
    pages.add(c.source_url);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
