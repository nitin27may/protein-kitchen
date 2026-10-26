import { asc, desc, eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { getDb } from "../server/context";
import { LIBRARY_PHOTOS_TAG } from "./tags";
import { EMPTY_LIBRARY_MANIFEST, type LibraryPhotoEntry, type LibraryPhotoManifest, type LibrarySubjectPhotos } from "./model";

export type { LibraryPhotoEntry, LibraryPhotoManifest, LibrarySubjectPhotos } from "./model";

/** Fixed code logged when the manifest cannot be read; never the error text, which may carry connection details. */
export const MANIFEST_UNAVAILABLE_CODE = "LIBRARY_PHOTO_MANIFEST_UNAVAILABLE";

/** Reads every approved library photo once. Subjects are keyed by slug; the cover comes first in each list. */
export async function readLibraryManifest(db: Db): Promise<LibraryPhotoManifest> {
  const rows = await db
    .select({ p: s.libraryPhotos, recipeSlug: s.recipes.slug })
    .from(s.libraryPhotos)
    .leftJoin(s.recipes, eq(s.recipes.id, s.libraryPhotos.recipeId))
    .orderBy(desc(s.libraryPhotos.isCover), asc(s.libraryPhotos.position), asc(s.libraryPhotos.id));
  const recipes: Record<string, LibraryPhotoEntry[]> = Object.create(null);
  const ingredients: Record<string, LibraryPhotoEntry[]> = Object.create(null);
  for (const { p, recipeSlug } of rows) {
    const entry: LibraryPhotoEntry = {
      uid: p.uid, w: p.width, h: p.height, title: p.title, author: p.author, licence: p.licence,
      licenceUrl: p.licenceUrl, sourceUrl: p.sourceUrl, origin: p.origin as LibraryPhotoEntry["origin"], candidateKey: p.candidateKey,
    };
    const [target, slug] = recipeSlug ? [recipes, recipeSlug] as const : [ingredients, p.ingredientSlug!] as const; // the subject check constraint guarantees one of the two
    (target[slug] ??= []).push(entry);
  }
  const subjects = (grouped: Record<string, LibraryPhotoEntry[]>): Record<string, LibrarySubjectPhotos> =>
    Object.fromEntries(Object.entries(grouped).map(([slug, photos]) => [slug, { cover: photos[0]!, photos }]));
  return { recipes: subjects(recipes), ingredients: subjects(ingredients) };
}

// An error is thrown out of the cached function on purpose: the data cache stores only successful results, so a
// database outage is retried on the next request instead of being cached as "no photos" for an hour.
// Created on first use, not at import, so importing this module never needs the Next cache runtime.
let cached: (() => Promise<LibraryPhotoManifest>) | undefined;
const cachedManifest = () => cached ??= unstable_cache(async () => readLibraryManifest(await getDb()), ["library-photo-manifest", "v1"], {
  tags: [LIBRARY_PHOTOS_TAG],
  revalidate: 3600,
});

/**
 * The approved library photos for every visitor. Cached for an hour and invalidated by tag when a photo is approved
 * or removed. Empty when nothing is approved, and empty (with a logged code) when the database cannot be read, so a
 * photo problem never fails a page.
 */
export async function libraryPhotoManifest(): Promise<LibraryPhotoManifest> {
  try {
    return await cachedManifest()();
  } catch {
    console.error(MANIFEST_UNAVAILABLE_CODE);
    return EMPTY_LIBRARY_MANIFEST;
  }
}
