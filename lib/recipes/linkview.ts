import type { RecipeLinkView } from "../links/types";
import type { PartView } from "./timeline";

/**
 * Pure helpers for showing recipe links. A link is saved on one recipe page. The meal page also loads the links saved
 * on its parts' own pages, so "a part's links" are the same everywhere the part is used. Every link therefore carries
 * `ownerSlug`, the page it is saved on, which is what an edit or a removal must be sent to.
 */

export const MAX_TITLE = 80;
export const MAX_SOURCE = 60;

export interface OwnedLink extends RecipeLinkView {
  /** The recipe or part page the link is saved on. */
  ownerSlug: string;
}

/** A part (or nested part) a link can be attached to, with how many steps it has. */
export interface LinkTargetPart {
  slug: string;
  name: string;
  stepCount: number;
}

const byPosition = (a: OwnedLink, b: OwnedLink) => a.position - b.position || a.id - b.id;

/**
 * Merges a meal's own links with the whole-page links saved on each part's page. A link from a part's page is
 * treated as belonging to that part (`partSlug` set to the part), so it shows on the part card in every meal.
 */
export function collectLinks(mealSlug: string, own: RecipeLinkView[], partOwn: Record<string, RecipeLinkView[]> = {}): OwnedLink[] {
  const out: OwnedLink[] = own.map((l) => ({ ...l, ownerSlug: mealSlug }));
  for (const [partSlug, links] of Object.entries(partOwn)) {
    if (partSlug === mealSlug) continue;
    for (const l of links) out.push({ ...l, ownerSlug: partSlug, partSlug });
  }
  return out;
}

/** Links for the whole recipe: not tied to a part or a step. */
export function wholeLinks(links: OwnedLink[]): OwnedLink[] {
  return links.filter((l) => l.partSlug === null && l.stepNo === null).sort(byPosition);
}

/** Links for a part as a whole, from the meal's page and from the part's own page. Meal-level ones come first. */
export function partLinks(links: OwnedLink[], partSlug: string): OwnedLink[] {
  return links
    .filter((l) => l.partSlug === partSlug && l.stepNo === null)
    .sort((a, b) => Number(a.ownerSlug === partSlug) - Number(b.ownerSlug === partSlug) || byPosition(a, b));
}

/** Links for one step. `partSlug` null means a step of the meal itself; `stepNo` is 1-based. */
export function stepLinks(links: OwnedLink[], partSlug: string | null, stepNo: number): OwnedLink[] {
  return links.filter((l) => l.partSlug === partSlug && l.stepNo === stepNo).sort(byPosition);
}

/** Cook mode: the links to show under the current step. Same rule as `stepLinks`, named for where it is used. */
export function linksForCookStep(links: OwnedLink[], partSlug: string | null, stepNo: number): OwnedLink[] {
  return stepLinks(links, partSlug, stepNo);
}

export interface LinkGroup {
  /** Part slug, or null for the meal itself. */
  partSlug: string | null;
  name: string;
  links: OwnedLink[];
}

/** Cook mode "Links" sheet: everything not tied to one step, grouped by the meal and then each part that has links. */
export function cookSheetGroups(links: OwnedLink[], mealName: string, parts: LinkTargetPart[]): LinkGroup[] {
  const groups: LinkGroup[] = [];
  const whole = wholeLinks(links);
  if (whole.length) groups.push({ partSlug: null, name: mealName, links: whole });
  for (const p of parts) {
    const own = partLinks(links, p.slug);
    if (own.length) groups.push({ partSlug: p.slug, name: p.name, links: own });
  }
  return groups;
}

/** Every part and nested part of a meal in reading order, for the editor's "applies to" lists. */
export function flattenParts(parts: PartView[]): LinkTargetPart[] {
  const out: LinkTargetPart[] = [];
  const walk = (list: PartView[]) => {
    for (const p of list) {
      out.push({ slug: p.slug, name: p.name, stepCount: p.steps.length });
      walk(p.children);
    }
  };
  walk(parts);
  return out;
}

/** "2:30" or "1:02:03". Null for no start time. */
export function describeStartTime(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Splits a start time into the minutes and seconds the editor shows. */
export function splitStartTime(sec: number | null | undefined): { min: string; sec: string } {
  if (!sec || sec <= 0) return { min: "", sec: "" };
  return { min: String(Math.floor(sec / 60)), sec: String(Math.floor(sec % 60)) };
}

/** Minutes and seconds typed in the editor to whole seconds. Null when both are empty or invalid. */
export function joinStartTime(min: string, sec: string): number | null {
  if (!min.trim() && !sec.trim()) return null;
  const m = Number(min.trim() || 0);
  const s = Number(sec.trim() || 0);
  if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0) return null;
  const total = Math.floor(m) * 60 + Math.floor(s);
  return total > 0 ? total : null;
}

const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

/** A light, client-side hint so the editor can pick "Video". The server decides what really counts as embeddable. */
export function looksLikeVideoUrl(raw: string): boolean {
  try {
    return VIDEO_HOSTS.has(new URL(raw.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Adds autoplay to a player URL, keeping the start time already in it. */
export function withAutoplay(src: string): string {
  return src.includes("?") ? `${src}&autoplay=1` : `${src}?autoplay=1`;
}

/** Where a link applies, in words, for lists that mix whole-recipe, part and step links. */
export function describeTarget(link: Pick<OwnedLink, "partSlug" | "stepNo">, partName: (slug: string) => string | null): string | null {
  const part = link.partSlug ? partName(link.partSlug) : null;
  if (part && link.stepNo) return `${part}, step ${link.stepNo}`;
  if (part) return part;
  if (link.stepNo) return `Step ${link.stepNo}`;
  return null;
}
