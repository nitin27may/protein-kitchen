import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { LinkKind, RecipeLinkView } from "../links/types";
import { parseLinkUrl } from "../links/url";

/**
 * Every link saved on a recipe page: the meal's own and the ones about its parts or steps. Ordered by part (the
 * meal itself first), then step (the whole thing first), then the order the person set. Sorted here, not in SQL,
 * because NULL ordering differs between SQLite and Postgres. `embed` is worked out from the URL at read time.
 */
export async function recipeLinksFor(db: Db, recipeSlug: string, householdId?: string): Promise<RecipeLinkView[]> {
  const rows = await db
    .select({ link: s.recipeLinks })
    .from(s.recipeLinks)
    .innerJoin(s.recipes, eq(s.recipes.id, s.recipeLinks.recipeId))
    .where(and(eq(s.recipes.slug, recipeSlug),
      householdId === undefined ? isNull(s.recipeLinks.householdId) : eq(s.recipeLinks.householdId, householdId)));
  const text = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  const num = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
  return rows
    .map((r) => r.link)
    .sort((a, b) => text(a.partSlug, b.partSlug) || num(a.stepNo, b.stepNo) || a.position - b.position || a.id - b.id)
    .map((l) => {
      const parsed = parseLinkUrl(l.url);
      return {
        id: l.id,
        uid: l.uid,
        kind: l.kind as LinkKind,
        url: l.url,
        title: l.title,
        source: l.source,
        startSec: l.startSec,
        partSlug: l.partSlug,
        stepNo: l.stepNo,
        position: l.position,
        embed: parsed.ok ? parsed.value.embed : null,
      };
    });
}
