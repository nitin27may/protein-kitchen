import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { Feedback } from "../planner/candidates";

export async function householdFeedback(db: Db): Promise<Map<string, Feedback>> {
  const rows = await db.select({ row: s.recipeFeedback, slug: s.recipes.slug }).from(s.recipeFeedback)
    .innerJoin(s.recipes, eq(s.recipes.id, s.recipeFeedback.recipeId));
  return new Map(rows.map(({ row, slug }) => [slug, {
    favourite: row.favourite, rating: row.rating, banned: row.banned, tested: row.status === "tested",
  }]));
}

async function choicesFor(db: Db, personIds: readonly number[]) {
  if (!personIds.length) return [];
  return db.select({ row: s.personRecipeFeedback, slug: s.recipes.slug }).from(s.personRecipeFeedback)
    .innerJoin(s.recipes, eq(s.recipes.id, s.personRecipeFeedback.recipeId))
    .where(inArray(s.personRecipeFeedback.personId, [...personIds]));
}

const blank = (): Feedback => ({ favourite: false, rating: null, banned: false, tested: false });

export async function personalFeedback(db: Db, personId: number): Promise<Map<string, Feedback>> {
  const shared = await householdFeedback(db);
  const result = new Map<string, Feedback>([...shared].map(([slug, row]) => [slug, { ...row, favourite: false, rating: null }]));
  for (const { row, slug } of await choicesFor(db, [personId])) {
    result.set(slug, { ...(result.get(slug) ?? blank()), favourite: row.favourite, rating: row.rating });
  }
  return result;
}

/** A low rating excludes a meal only for plans containing that eater; old history is never attributed. */
export async function planningFeedback(db: Db, personIds: readonly number[]): Promise<Map<string, Feedback>> {
  const result = await householdFeedback(db);
  const grouped = new Map<string, { favourite: boolean; ratings: number[] }>();
  for (const { row, slug } of await choicesFor(db, personIds)) {
    const group = grouped.get(slug) ?? { favourite: false, ratings: [] };
    group.favourite ||= row.favourite;
    if (row.rating !== null) group.ratings.push(row.rating);
    grouped.set(slug, group);
  }
  for (const [slug, group] of grouped) {
    const low = group.ratings.filter((rating) => rating <= 2);
    const rating = low.length ? Math.min(...low) : group.ratings.length
      ? group.ratings.reduce((sum, value) => sum + value, 0) / group.ratings.length : null;
    result.set(slug, { ...(result.get(slug) ?? blank()), favourite: group.favourite, rating });
  }
  return result;
}
