import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import {
  EMPTY_LIBRARY_MANIFEST, libraryCandidateKeys, libraryCoverUrls, libraryCreditLines, libraryViews,
  type LibraryPhotoManifest, type LibrarySubjectKind,
} from "../library-photos/model";
import { photoUrl } from "../photos/keys";
import type { CreditedPhoto, PhotoView } from "../photos/view";

export type { CreditedPhoto, PhotoView };

type Row = typeof s.photos.$inferSelect;

const viewOf = (p: Row): PhotoView => ({
  uid: p.uid,
  url: photoUrl(p.uid, "master"),
  thumbUrl: photoUrl(p.uid, "thumb"),
  isCover: p.isCover,
  origin: p.origin as PhotoView["origin"],
  scope: "household",
  width: p.width,
  height: p.height,
  title: p.title,
  author: p.author,
  licence: p.licence,
  licenceUrl: p.licenceUrl,
  sourceUrl: p.sourceUrl,
});
const owned = (householdId?: string) => householdId === undefined ? isNull(s.photos.householdId) : eq(s.photos.householdId, householdId);

/** A household copy of a candidate the library already shows is hidden: the library copy wins. */
const notInLibrary = (hidden: ReadonlySet<string>) => (p: Row) => p.candidateKey === null || !hidden.has(p.candidateKey);

/**
 * One cover per subject. Your own uploaded cover beats the library cover; the library cover beats a household
 * candidate-origin cover; a household candidate cover is used only when the library has none.
 */
function withSingleCover(household: PhotoView[], library: PhotoView[]): PhotoView[] {
  const own = household.find((p) => p.isCover && p.origin === "upload");
  const cover = own ?? library.find((p) => p.isCover) ?? household.find((p) => p.isCover);
  return [...household, ...library].map((p) => ({ ...p, isCover: p === cover }));
}

/** Every photo of a recipe: your household's first (cover first), then the library's. Exactly one is the cover. */
export async function photosOfRecipe(db: Db, recipeId: number, householdId?: string, library: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): Promise<PhotoView[]> {
  const [recipe] = await db.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, recipeId)).limit(1);
  const hidden = recipe ? libraryCandidateKeys(library, "recipe", recipe.slug) : new Set<string>();
  const rows = await db.select().from(s.photos).where(and(eq(s.photos.recipeId, recipeId), owned(householdId))).orderBy(desc(s.photos.isCover), asc(s.photos.position), asc(s.photos.id));
  return withSingleCover(rows.filter(notInLibrary(hidden)).map(viewOf), recipe ? libraryViews(library, "recipe", recipe.slug) : []);
}

export async function photosOfIngredient(db: Db, slug: string, householdId?: string, library: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): Promise<PhotoView[]> {
  const rows = await db.select().from(s.photos).where(and(eq(s.photos.ingredientSlug, slug), owned(householdId))).orderBy(desc(s.photos.isCover), asc(s.photos.position), asc(s.photos.id));
  return withSingleCover(rows.filter(notInLibrary(libraryCandidateKeys(library, "ingredient", slug))).map(viewOf), libraryViews(library, "ingredient", slug));
}

export interface PhotoIndex {
  /** Cover photo URL (thumb size) by recipe slug. */
  recipes: Map<string, string>;
  /** Cover photo URL (thumb size) by ingredient slug. */
  ingredients: Map<string, string>;
}

/**
 * One query for every cover, for list pages. A subject with no photo is absent from the maps. The library manifest
 * fills in subjects the household has no upload for; a household upload always wins.
 */
export async function photoIndex(db: Db, householdId?: string, library: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): Promise<PhotoIndex> {
  const recipes = libraryCoverUrls(library, "recipe");
  const ingredients = libraryCoverUrls(library, "ingredient");
  const forRecipes = await db.select({ slug: s.recipes.slug, uid: s.photos.uid, origin: s.photos.origin }).from(s.photos).innerJoin(s.recipes, eq(s.recipes.id, s.photos.recipeId)).where(and(eq(s.photos.isCover, true), owned(householdId)));
  for (const r of forRecipes) if (r.origin === "upload" || !recipes.has(r.slug)) recipes.set(r.slug, photoUrl(r.uid, "thumb"));
  const forIngredients = await db.select({ slug: s.photos.ingredientSlug, uid: s.photos.uid, origin: s.photos.origin }).from(s.photos).where(and(eq(s.photos.isCover, true), isNull(s.photos.recipeId), owned(householdId)));
  for (const r of forIngredients) if (r.slug && (r.origin === "upload" || !ingredients.has(r.slug))) ingredients.set(r.slug, photoUrl(r.uid, "thumb"));
  return { recipes, ingredients };
}

/** Library credits plus your household's own candidate-origin photos that the library does not already show. Uploads need no credit. */
export async function creditedPhotos(db: Db, householdId?: string, library: LibraryPhotoManifest = EMPTY_LIBRARY_MANIFEST): Promise<CreditedPhoto[]> {
  const rows = await db.select({ p: s.photos, recipeSlug: s.recipes.slug }).from(s.photos).leftJoin(s.recipes, eq(s.recipes.id, s.photos.recipeId)).where(owned(householdId));
  const household = rows.flatMap(({ p, recipeSlug }): CreditedPhoto[] => {
    const kind: LibrarySubjectKind = recipeSlug ? "recipe" : "ingredient";
    const slug = recipeSlug ?? p.ingredientSlug;
    if (p.origin === "upload" || !slug || !notInLibrary(libraryCandidateKeys(library, kind, slug))(p)) return [];
    return [{ uid: p.uid, subjectKind: kind, subjectSlug: slug, scope: "household", title: p.title, author: p.author, licence: p.licence, licenceUrl: p.licenceUrl, sourceUrl: p.sourceUrl }];
  });
  return [...libraryCreditLines(library), ...household];
}
