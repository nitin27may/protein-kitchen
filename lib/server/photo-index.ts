import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { photoUrl } from "../photos/keys";

export interface PhotoView {
  uid: string;
  url: string;
  thumbUrl: string;
  isCover: boolean;
  origin: "upload" | "commons" | "openverse";
  width: number;
  height: number;
  /** Credit line parts for approved candidates; empty for your own photos. */
  title: string | null;
  author: string | null;
  licence: string | null;
  licenceUrl: string | null;
  sourceUrl: string | null;
}

const viewOf = (p: typeof s.photos.$inferSelect): PhotoView => ({
  uid: p.uid,
  url: photoUrl(p.uid, "master"),
  thumbUrl: photoUrl(p.uid, "thumb"),
  isCover: p.isCover,
  origin: p.origin as PhotoView["origin"],
  width: p.width,
  height: p.height,
  title: p.title,
  author: p.author,
  licence: p.licence,
  licenceUrl: p.licenceUrl,
  sourceUrl: p.sourceUrl,
});

/** Every photo of a recipe, cover first, then in the order they were added. */
export async function photosOfRecipe(db: Db, recipeId: number): Promise<PhotoView[]> {
  const rows = await db.select().from(s.photos).where(eq(s.photos.recipeId, recipeId)).orderBy(desc(s.photos.isCover), asc(s.photos.position), asc(s.photos.id));
  return rows.map(viewOf);
}

export async function photosOfIngredient(db: Db, slug: string): Promise<PhotoView[]> {
  const rows = await db.select().from(s.photos).where(eq(s.photos.ingredientSlug, slug)).orderBy(desc(s.photos.isCover), asc(s.photos.position), asc(s.photos.id));
  return rows.map(viewOf);
}

export interface PhotoIndex {
  /** Cover photo URL (thumb size) by recipe slug. */
  recipes: Map<string, string>;
  /** Cover photo URL (thumb size) by ingredient slug. */
  ingredients: Map<string, string>;
}

/** One query for every cover, for list pages. A subject with no photo is absent from the maps. */
export async function photoIndex(db: Db): Promise<PhotoIndex> {
  const recipes = new Map<string, string>();
  const ingredients = new Map<string, string>();
  const forRecipes = await db.select({ slug: s.recipes.slug, uid: s.photos.uid }).from(s.photos).innerJoin(s.recipes, eq(s.recipes.id, s.photos.recipeId)).where(eq(s.photos.isCover, true));
  for (const r of forRecipes) recipes.set(r.slug, photoUrl(r.uid, "thumb"));
  const forIngredients = await db.select({ slug: s.photos.ingredientSlug, uid: s.photos.uid }).from(s.photos).where(and(eq(s.photos.isCover, true), isNull(s.photos.recipeId)));
  for (const r of forIngredients) if (r.slug) ingredients.set(r.slug, photoUrl(r.uid, "thumb"));
  return { recipes, ingredients };
}
