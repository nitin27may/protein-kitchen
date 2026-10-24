import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "../lib/data/load";
import type { Candidate, CandidateFile } from "../lib/photos/candidates";
import { candidatesPath, dedupeCandidates, loadCandidates, parseCommonsPage, parseOpenverseResult } from "../lib/photos/candidates";

/**
 * Builds data/photo-candidates.json: up to six freely licensed photos per recipe and ingredient, from the lead image of the
 * matching Wikipedia article, a Wikimedia Commons search, and Openverse (CC0, CC BY, CC BY-SA only). Nothing here is shown
 * in the app. The review page (/photos/review) lists these and a person approves each one.
 *
 *   pnpm exec tsx scripts/photo-candidates.ts            subjects with no candidates yet (add --limit 20 to try a few)
 *   pnpm exec tsx scripts/photo-candidates.ts --refresh  redo every subject
 *   pnpm exec tsx scripts/photo-candidates.ts --only falafel-bowl,tofu-extra-firm
 *
 * Wikipedia lead images come from data/image-titles.json (slug -> article title; null blocks a subject).
 * Openverse's anonymous limit is small, so it only tops up subjects that Commons left with fewer than three candidates.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "ProteinKitchen/0.1 (personal meal planner)";
const STOP = new Set(["and", "with", "the", "of", "in", "a", "dry", "cooked", "raw", "ready", "plain", "whole", "fresh", "canned", "prepared", "baked", "style"]);

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const limit = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const only = args.includes("--only") ? new Set((args[args.indexOf("--only") + 1] ?? "").split(",")) : null;

const readJson = <T,>(file: string, fallback: T): T => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback);
// slug -> Wikipedia article whose lead image is the first candidate; null blocks the subject (no candidates at all).
const pinned = readJson<Record<string, string | null>>(path.join(root, "data", "image-titles.json"), {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wikimedia answers 429 to a fast client, so every request waits its turn.
let lastRequest = 0;
const MIN_GAP_MS = 800;

async function getJson(url: string): Promise<any> {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await sleep(8000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`rate limited: ${url}`);
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2 && !STOP.has(t));
const stem = (t: string) => t.replace(/(es|s)$/, "");
const overlaps = (query: string, title: string) => {
  const q = new Set(tokens(query).map(stem));
  return tokens(title).some((t) => q.has(stem(t)));
};

const commons = (params: Record<string, string>) => getJson(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: "json", origin: "*", ...params })}`);

async function leadFileTitle(articleTitle: string): Promise<string | null> {
  const r = await getJson(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ format: "json", origin: "*", action: "query", titles: articleTitle, prop: "pageimages", piprop: "name", redirects: "1" })}`);
  const page = Object.values<any>(r.query?.pages ?? {})[0];
  return page?.pageimage ? `File:${page.pageimage}` : null;
}

const IMAGE_QUERY = { action: "query", prop: "imageinfo", iiprop: "url|extmetadata|size|mime", iiurlwidth: "1280" };

async function commonsByTitle(fileTitle: string): Promise<Candidate | null> {
  const r = await commons({ ...IMAGE_QUERY, titles: fileTitle });
  const page = Object.values<any>(r.query?.pages ?? {})[0];
  return page ? parseCommonsPage(page) : null;
}

async function commonsSearch(term: string): Promise<Candidate[]> {
  const r = await commons({ ...IMAGE_QUERY, generator: "search", gsrsearch: `${term} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "14" });
  const pages = Object.values<any>(r.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.flatMap((p) => {
    const c = parseCommonsPage(p);
    return c && overlaps(term, c.title) ? [c] : [];
  });
}

async function openverseSearch(term: string): Promise<Candidate[]> {
  const r = await getJson(`https://api.openverse.org/v1/images/?${new URLSearchParams({ q: term, license: "cc0,by,by-sa", page_size: "10", mature: "false" })}`);
  return (r.results ?? []).flatMap((x: any) => {
    const c = parseOpenverseResult(x);
    return c && overlaps(term, c.title) ? [c] : [];
  });
}

const searchTerm = (kind: "recipes" | "ingredients", name: string): string => (kind === "ingredients" ? (name.split(",")[0] ?? name) : name).replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();

async function main() {
  const data = loadData(root);
  const out: CandidateFile = loadCandidates(root);
  const jobs = [
    ...[...data.recipes.values()].filter((r) => r.kind === "recipe").map((r) => ({ kind: "recipes" as const, slug: r.slug, name: r.name })),
    ...[...data.ingredients.values()].map((i) => ({ kind: "ingredients" as const, slug: i.slug, name: i.display_name ?? i.name })),
  ].filter((j) => (only ? only.has(j.slug) : refresh || !(out[j.kind][j.slug]?.length)));

  let done = 0;
  let openverseOff = false;
  const save = () => {
    const sorted: CandidateFile = { recipes: {}, ingredients: {} };
    for (const kind of ["recipes", "ingredients"] as const) for (const k of Object.keys(out[kind]).sort()) sorted[kind][k] = out[kind][k]!;
    fs.writeFileSync(candidatesPath(root), `${JSON.stringify(sorted, null, 2)}\n`);
  };

  for (const { kind, slug, name } of jobs) {
    if (done >= limit) break;
    if (pinned[slug] === null) {
      out[kind][slug] = [];
      continue;
    }
    const term = searchTerm(kind, name);
    const found: Candidate[] = [];
    try {
      const article = pinned[slug];
      if (article) {
        const file = await leadFileTitle(article);
        const lead = file ? await commonsByTitle(file) : null;
        if (lead) found.push(lead);
      }
      found.push(...(await commonsSearch(term)));
      // "Baked falafel bowl" finds nothing on Commons, "falafel bowl" does: drop leading words until something turns up.
      for (let words = term.split(" ").slice(1); found.length < 3 && words.length > 0; words = words.slice(1)) found.push(...(await commonsSearch(words.join(" "))));
      if (found.length < 3 && !openverseOff) {
        try {
          found.push(...(await openverseSearch(term)));
        } catch (e) {
          openverseOff = true;
          console.warn(`openverse paused for this run: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`skip ${slug}: ${(e as Error).message}`);
      continue;
    }
    out[kind][slug] = dedupeCandidates(found, 6);
    done++;
    console.log(`${kind}/${slug}: ${out[kind][slug]!.length}`);
    if (done % 10 === 0) save();
    await sleep(200);
  }
  save();
  const total = (k: "recipes" | "ingredients") => Object.values(out[k]).reduce((n, l) => n + l.length, 0);
  console.log(`\n${Object.keys(out.recipes).length} recipes (${total("recipes")} candidates), ${Object.keys(out.ingredients).length} ingredients (${total("ingredients")} candidates)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
