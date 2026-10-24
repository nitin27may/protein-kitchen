import { and, asc, count as countRows, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { deleteLinkRow, reorderLinks, updateLinkRow, writeLink } from "../human/links";
import { LINK_KINDS } from "../links/types";
import type { LinkInput } from "../links/types";
import { normaliseSource, normaliseStartSec, normaliseTitle, parseLinkUrl } from "../links/url";
import type { Recipe } from "../schemas";

/** Links per recipe page. Enough for a recipe, a video and a few parts; keeps the page readable. */
export const MAX_LINKS_PER_RECIPE = 12;

export type LinkFailure = { ok: false; error: string; fields?: Record<string, string> };
export type LinkOutcome<T = object> = ({ ok: true } & T) | LinkFailure;

const fail = (field: string, message: string): LinkFailure => ({ ok: false, error: message, fields: { [field]: message } });
const owned = (householdId?: string) => householdId === undefined ? isNull(s.recipeLinks.householdId) : eq(s.recipeLinks.householdId, householdId);

/** Component slugs a recipe uses, directly or through other components. */
export function partsUsedBy(recipe: Recipe, recipes: ReadonlyMap<string, Recipe>, seen: Set<string> = new Set()): Set<string> {
  for (const item of recipe.items) {
    if (!("component" in item) || seen.has(item.component)) continue;
    seen.add(item.component);
    const part = recipes.get(item.component);
    if (part) partsUsedBy(part, recipes, seen);
  }
  return seen;
}

interface Checked {
  recipeId: number;
  recipe: Recipe;
  row: { partSlug: string | null; stepNo: number | null; kind: LinkInput["kind"]; url: string; title: string; source: string | null; startSec: number | null };
}

/** Everything that can be wrong with a link before it is saved. Returns the cleaned row, or the first problem. */
async function check(db: Db, recipes: ReadonlyMap<string, Recipe>, input: LinkInput, excludeId?: number, householdId?: string): Promise<LinkOutcome<{ checked: Checked }>> {
  const recipe = recipes.get(input.recipeSlug);
  if (!recipe) return fail("recipeSlug", "That recipe no longer exists");
  const recipeRow = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, input.recipeSlug)))[0];
  if (!recipeRow) return fail("recipeSlug", "That recipe no longer exists");

  if (!(LINK_KINDS as readonly string[]).includes(input.kind)) return fail("kind", "Choose recipe page, video or article");

  const url = parseLinkUrl(input.url);
  if (!url.ok) return fail("url", url.error);
  const title = normaliseTitle(input.title);
  if (!title.ok) return fail("title", title.error);
  const source = normaliseSource(input.source);
  if (!source.ok) return fail("source", source.error);
  const startSec = normaliseStartSec(input.startSec);
  if (!startSec.ok) return fail("startSec", startSec.error);

  const partSlug = input.partSlug ? input.partSlug : null;
  let stepCount = recipe.steps.length;
  if (partSlug) {
    const part = recipes.get(partSlug);
    if (!part || part.kind !== "component" || !partsUsedBy(recipe, recipes).has(partSlug)) {
      return fail("partSlug", "That part is not part of this meal");
    }
    stepCount = part.steps.length;
  }
  const stepNo = input.stepNo ?? null;
  if (stepNo !== null && (!Number.isInteger(stepNo) || stepNo < 1 || stepNo > stepCount)) {
    return fail("stepNo", `Choose a step from 1 to ${stepCount}`);
  }

  const sameRecipe = and(eq(s.recipeLinks.recipeId, recipeRow.id), owned(householdId));
  const others = excludeId === undefined ? sameRecipe : and(sameRecipe, ne(s.recipeLinks.id, excludeId));
  const duplicate = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(and(others, eq(s.recipeLinks.url, url.value.url))))[0];
  if (duplicate) return fail("url", "That link is already saved on this recipe");

  if (excludeId === undefined) {
    const [n] = await db.select({ n: countRows() }).from(s.recipeLinks).where(sameRecipe);
    if (Number(n?.n ?? 0) >= MAX_LINKS_PER_RECIPE) return fail("url", `A recipe can have up to ${MAX_LINKS_PER_RECIPE} links. Remove one first`);
  }

  return {
    ok: true,
    checked: { recipeId: recipeRow.id, recipe, row: { partSlug, stepNo, kind: input.kind, url: url.value.url, title: title.value, source: source.value, startSec: startSec.value } },
  };
}

export async function addLinkChecked(db: Db, recipes: ReadonlyMap<string, Recipe>, input: LinkInput, personId?: number | null, householdId?: string): Promise<LinkOutcome<{ id: number; recipeSlug: string }>> {
  const result = await check(db, recipes, input, undefined, householdId);
  if (!result.ok) return result;
  const { id } = await writeLink(db, result.checked.recipeId, result.checked.row, personId, householdId);
  return { ok: true, id, recipeSlug: input.recipeSlug };
}

async function linkWithSlug(db: Db, id: number, householdId?: string): Promise<{ recipeId: number; slug: string } | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const row = (
    await db
      .select({ recipeId: s.recipeLinks.recipeId, slug: s.recipes.slug })
      .from(s.recipeLinks)
      .innerJoin(s.recipes, eq(s.recipes.id, s.recipeLinks.recipeId))
      .where(and(eq(s.recipeLinks.id, id), owned(householdId)))
  )[0];
  return row;
}

export async function updateLinkChecked(db: Db, recipes: ReadonlyMap<string, Recipe>, id: number, input: LinkInput, householdId?: string): Promise<LinkOutcome<{ recipeSlug: string }>> {
  const current = await linkWithSlug(db, id, householdId);
  if (!current) return { ok: false, error: "That link no longer exists" };
  if (current.slug !== input.recipeSlug) return fail("recipeSlug", "A link cannot move to another recipe. Add it there instead");
  const result = await check(db, recipes, input, id, householdId);
  if (!result.ok) return result;
  await updateLinkRow(db, id, result.checked.row, householdId);
  return { ok: true, recipeSlug: current.slug };
}

export async function removeLinkChecked(db: Db, id: number, householdId?: string): Promise<LinkOutcome<{ recipeSlug: string }>> {
  const current = await linkWithSlug(db, id, householdId);
  if (!current) return { ok: false, error: "That link no longer exists" };
  await deleteLinkRow(db, id, householdId);
  return { ok: true, recipeSlug: current.slug };
}

/** Swaps the link with its neighbour in the recipe's list. Moving the first up or the last down does nothing. */
export async function moveLinkChecked(db: Db, id: number, direction: "up" | "down", householdId?: string): Promise<LinkOutcome<{ recipeSlug: string }>> {
  const current = await linkWithSlug(db, id, householdId);
  if (!current) return { ok: false, error: "That link no longer exists" };
  const rows = await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(and(eq(s.recipeLinks.recipeId, current.recipeId), owned(householdId))).orderBy(asc(s.recipeLinks.position), asc(s.recipeLinks.id));
  const order = rows.map((r) => r.id);
  const at = order.indexOf(id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (to >= 0 && to < order.length) {
    [order[at], order[to]] = [order[to]!, order[at]!];
    await reorderLinks(db, current.recipeId, order, householdId);
  }
  return { ok: true, recipeSlug: current.slug };
}
