import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "../lib/data/load";

/**
 * Finds a freely licensed photo for every recipe and ingredient from the lead image of the best-matching
 * Wikipedia article. Only CC0, public domain, CC BY and CC BY-SA files are kept. Results go to
 * data/images.json (slug -> file + credit); images that cannot be matched are listed in data/images-missing.json.
 * Re-running skips slugs that already have an image. Pin a wrong match with data/image-titles.json
 * ({ "slug": "Wikipedia title" }) or block one with null.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "ProteinKitchen/0.1 (personal meal planner; nitin27may@gmail.com)";
const OK_LICENCE = /^(cc0|public domain|pd|cc[ -]by(-sa)?[ -][\d.]+)/i;
const STOP = new Set(["and", "with", "the", "of", "in", "a", "dry", "cooked", "raw", "ready", "plain", "whole", "fresh", "canned", "prepared"]);

type Kind = "recipes" | "ingredients";
interface Entry { file: string; credit: string; title: string }
type Manifest = Record<Kind, Record<string, Entry>>;

const manifestPath = path.join(root, "data", "images.json");
const titlesPath = path.join(root, "data", "image-titles.json");
const manifest: Manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { recipes: {}, ingredients: {} };
const pinned: Record<string, string | null> = fs.existsSync(titlesPath) ? JSON.parse(fs.readFileSync(titlesPath, "utf8")) : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(host: string, params: Record<string, string>): Promise<any> {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: "json", origin: "*", ...params })}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`rate limited: ${url}`);
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2 && !STOP.has(t));
const stem = (t: string) => t.replace(/(es|s)$/, "");

function overlaps(query: string, title: string): boolean {
  const q = new Set(tokens(query).map(stem));
  return tokens(title).some((t) => q.has(stem(t)));
}

function searchTerm(kind: Kind, name: string): string {
  const base = kind === "ingredients" ? (name.split(",")[0] ?? name) : name;
  return base.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
}

async function leadImage(title: string): Promise<{ title: string; file: string } | null> {
  const r = await api("en.wikipedia.org", { action: "query", titles: title, prop: "pageimages", piprop: "name", redirects: "1" });
  const page = Object.values<any>(r.query?.pages ?? {})[0];
  return page?.pageimage ? { title: page.title, file: page.pageimage } : null;
}

async function resolveTitle(kind: Kind, term: string): Promise<string | null> {
  const queries = kind === "recipes" ? [`${term} dish`, term] : [`${term} food`, term];
  for (const q of queries) {
    const r = await api("en.wikipedia.org", { action: "query", list: "search", srsearch: q, srlimit: "3", srnamespace: "0" });
    for (const hit of r.query?.search ?? []) if (overlaps(term, hit.title)) return hit.title;
  }
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function licensedFile(file: string): Promise<{ url: string; credit: string } | null> {
  const r = await api("commons.wikimedia.org", {
    action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "640",
  });
  const info = Object.values<any>(r.query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  const licence: string = meta.LicenseShortName?.value ?? "";
  if (!OK_LICENCE.test(licence)) return null;
  const artist = stripHtml(meta.Artist?.value ?? "unknown author");
  return { url: info.thumburl ?? info.url, credit: `${artist}, ${licence}, via Wikimedia Commons` };
}

async function download(url: string, dest: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) return false;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    // Ingredients show as small thumbnails; recipes get a larger hero. macOS sips keeps this dependency-free.
    const longEdge = dest.includes("ingredient-images") ? "240" : "960";
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "72", "-Z", longEdge, dest], { stdio: "ignore" });
    return true;
  }
  return false;
}

async function main() {
  const data = loadData(root);
  const jobs: { kind: Kind; slug: string; name: string }[] = [
    ...[...data.recipes.values()].filter((r) => r.kind === "recipe").map((r) => ({ kind: "recipes" as const, slug: r.slug, name: r.name })),
    ...[...data.ingredients.values()].map((i) => ({ kind: "ingredients" as const, slug: i.slug, name: i.display_name ?? i.name })),
  ];
  const missing: { kind: Kind; slug: string; name: string; reason: string }[] = [];

  for (const { kind, slug, name } of jobs) {
    if (manifest[kind][slug]) continue;
    const dir = path.join(root, "public", kind === "recipes" ? "recipe-images" : "ingredient-images");
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (pinned[slug] === null) { missing.push({ kind, slug, name, reason: "blocked" }); continue; }
      const term = searchTerm(kind, name);
      const title = pinned[slug] ?? (await resolveTitle(kind, term));
      if (!title) { missing.push({ kind, slug, name, reason: "no matching article" }); continue; }
      const lead = await leadImage(title);
      if (!lead) { missing.push({ kind, slug, name, reason: `no lead image on "${title}"` }); continue; }
      const lic = await licensedFile(lead.file);
      if (!lic) { missing.push({ kind, slug, name, reason: `image on "${lead.title}" is not freely licensed or has no metadata` }); continue; }
      const file = `${slug}.jpg`;
      if (!(await download(lic.url, path.join(dir, file)))) { missing.push({ kind, slug, name, reason: "download failed" }); continue; }
      manifest[kind][slug] = { file, credit: lic.credit, title: lead.title };
      console.log(`ok   ${kind}/${slug} <- ${lead.title}`);
    } catch (e) {
      missing.push({ kind, slug, name, reason: (e as Error).message });
    }
    await sleep(150);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "data", "images-missing.json"), JSON.stringify(missing, null, 2) + "\n");
  console.log(`\n${Object.keys(manifest.recipes).length} recipe and ${Object.keys(manifest.ingredients).length} ingredient images; ${missing.length} unmatched (data/images-missing.json)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
