/**
 * The household's food catalog: library ingredients plus the household's own foods. Pure.
 * Must not import lib/server, lib/db, lib/auth, lib/human, lib/blob or next/*.
 *
 * Keys: a library ingredient is its kebab-case slug. A household food is `hf:<uid>`; the colon means it can never
 * collide with a slug.
 */
import { foldText } from "./diet-screen";

export interface LibraryIngredientRef {
  slug: string;
  name: string;
  aliases?: readonly string[];
  aisle?: string;
}

export interface HouseholdFoodRef {
  uid: string;
  name: string;
  brand?: string | null;
  aliases?: readonly string[];
  barcode?: string | null;
  aisle?: string;
}

export interface CatalogItem {
  key: string;
  source: "library" | "household";
  name: string;
  brand?: string;
  aliases: string[];
  /** GTIN-14 form, for comparison. */
  barcode?: string;
  aisle?: string;
}

export const HOUSEHOLD_PREFIX = "hf:";

export function householdKey(uid: string): string {
  return `${HOUSEHOLD_PREFIX}${uid}`;
}

export function parseFoodKey(key: string): { source: "library"; slug: string } | { source: "household"; uid: string } {
  return key.startsWith(HOUSEHOLD_PREFIX) ? { source: "household", uid: key.slice(HOUSEHOLD_PREFIX.length) } : { source: "library", slug: key };
}

// --- GTIN ---------------------------------------------------------------------------------------------------

/** Digits only: spaces and hyphens removed. Anything else is kept so validation fails. */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** GS1 check digit: weights 3,1,3,1 from the digit next to the check digit. */
export function isValidGtin(raw: string): boolean {
  const code = normalizeBarcode(raw);
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() as number;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Zero-padded to 14 digits so UPC-A, EAN-13 and GTIN-14 forms of one product compare equal. Undefined if not a valid GTIN. */
export function toGtin14(raw: string): string | undefined {
  return isValidGtin(raw) ? normalizeBarcode(raw).padStart(14, "0") : undefined;
}

// --- Catalog ------------------------------------------------------------------------------------------------

export function buildCatalog(library: readonly LibraryIngredientRef[], household: readonly HouseholdFoodRef[]): CatalogItem[] {
  const items: CatalogItem[] = library.map((i) => ({
    key: i.slug,
    source: "library",
    name: i.name,
    aliases: [...(i.aliases ?? [])],
    ...(i.aisle ? { aisle: i.aisle } : {}),
  }));
  for (const f of household) {
    const barcode = f.barcode ? toGtin14(f.barcode) : undefined;
    items.push({
      key: householdKey(f.uid),
      source: "household",
      name: f.name,
      aliases: [...(f.aliases ?? [])],
      ...(f.brand ? { brand: f.brand } : {}),
      ...(barcode ? { barcode } : {}),
      ...(f.aisle ? { aisle: f.aisle } : {}),
    });
  }
  return items;
}

export interface Usage {
  count: number;
  /** ISO timestamp of the last log. */
  lastLoggedAt?: string;
}

export type UsageMap = Readonly<Record<string, Usage | undefined>>;

const RECENT_DAYS = 14;

/** Small boost for foods the household logs often or lately. Never larger than one relevance tier. */
function usageBoost(usage: Usage | undefined, now: Date): number {
  if (!usage) return 0;
  const frequent = Math.min(usage.count, 20);
  const last = usage.lastLoggedAt ? Date.parse(usage.lastLoggedAt) : Number.NaN;
  const recent = Number.isFinite(last) && now.getTime() - last <= RECENT_DAYS * 86_400_000 ? 10 : 0;
  return frequent + recent;
}

function tokens(text: string): string[] {
  const folded = foldText(text);
  return folded === "" ? [] : folded.split(" ");
}

/** Relevance of one query token against one field: whole text, word start, or anywhere. */
function fieldScore(token: string, field: string): number {
  const folded = foldText(field);
  if (folded === token) return 1000;
  const words = folded.split(" ");
  if (words.includes(token)) return 800;
  if (folded.startsWith(token) || words.some((w) => w.startsWith(token))) return 600;
  return folded.includes(token) ? 300 : 0;
}

function itemScore(item: CatalogItem, queryTokens: readonly string[]): number {
  let total = 0;
  for (const t of queryTokens) {
    const name = fieldScore(t, item.name);
    const brand = item.brand ? fieldScore(t, item.brand) - 100 : 0;
    const alias = item.aliases.reduce((best, a) => Math.max(best, fieldScore(t, a) - 50), 0);
    const best = Math.max(name, brand, alias);
    if (best <= 0) return 0;
    total += best;
  }
  return total / queryTokens.length;
}

export interface SearchOptions {
  usage?: UsageMap;
  limit?: number;
  now?: Date;
}

/**
 * Search by name, brand, alias or exact barcode. Every query word must match somewhere. An empty query lists
 * the most used foods first. Within the same relevance, recently and frequently logged foods come first.
 */
export function searchCatalog(items: readonly CatalogItem[], query: string, options: SearchOptions = {}): CatalogItem[] {
  const usage = options.usage ?? {};
  const now = options.now ?? new Date();
  const limit = options.limit ?? 20;
  const boost = (i: CatalogItem) => usageBoost(usage[i.key], now);
  const byBoostThenName = (a: CatalogItem, b: CatalogItem) => boost(b) - boost(a) || a.name.localeCompare(b.name);

  const q = query.trim();
  if (q === "") return [...items].sort(byBoostThenName).slice(0, limit);

  const gtin = toGtin14(q);
  if (gtin) {
    const exact = items.filter((i) => i.barcode === gtin);
    if (exact.length > 0) return exact.slice(0, limit);
  }

  const queryTokens = tokens(q);
  if (queryTokens.length === 0) return [];
  return items
    .map((item) => ({ item, score: itemScore(item, queryTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score + boost(b.item) - (a.score + boost(a.item)) || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map((r) => r.item);
}

// --- Dedupe -------------------------------------------------------------------------------------------------

export interface FoodCandidate {
  name: string;
  brand?: string | null;
  barcode?: string | null;
}

export interface DuplicateReport {
  /** Same barcode: this is the same product. */
  barcodeMatch?: CatalogItem;
  /** Same or very similar name and brand. */
  nearMatches: CatalogItem[];
  warning?: string;
}

const FILLER = new Set(["the", "a", "an", "of", "and", "with", "le", "la", "les", "de", "du", "des", "et"]);

/** Name and brand as sorted unique words, for comparison. */
export function nearKey(name: string, brand?: string | null): string[] {
  const words = tokens(`${brand ?? ""} ${name}`).filter((w) => !FILLER.has(w));
  return [...new Set(words)].sort();
}

function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w)).length;
  return shared / (a.length + b.length - shared);
}

export const NEAR_MATCH_THRESHOLD = 0.8;

export function findDuplicates(candidate: FoodCandidate, items: readonly CatalogItem[]): DuplicateReport {
  const gtin = candidate.barcode ? toGtin14(candidate.barcode) : undefined;
  const barcodeMatch = gtin ? items.find((i) => i.barcode === gtin) : undefined;
  const key = nearKey(candidate.name, candidate.brand);
  const nearMatches = items.filter((i) => i !== barcodeMatch && similarity(key, nearKey(i.name, i.brand)) >= NEAR_MATCH_THRESHOLD);

  let warning: string | undefined;
  if (barcodeMatch) warning = `This barcode is already saved as "${barcodeMatch.name}".`;
  else if (nearMatches[0]) warning = `Looks like "${nearMatches[0].name}", which is already in the list. Check before adding another.`;
  return { ...(barcodeMatch ? { barcodeMatch } : {}), nearMatches, ...(warning ? { warning } : {}) };
}
