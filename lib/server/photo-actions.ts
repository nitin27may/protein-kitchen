import { and, eq, isNull } from "drizzle-orm";
import type { PhotoWriteScope } from "../human/photos";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { deletePhoto, setCoverPhoto, writeUploadedPhoto } from "../human";
import { MAX_UPLOAD_BYTES, PhotoError } from "../photos/process";
import { isPhotoUid } from "../photos/keys";

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const owned = (householdId?: string) => householdId === undefined ? isNull(s.photos.householdId) : eq(s.photos.householdId, householdId);

/** Most photos kept per recipe. A guard against a runaway upload loop, not a product limit people should meet. */
export const MAX_PHOTOS_PER_RECIPE = 12;

/** Validates an upload for a recipe and stores it. The file is already resized on the phone; the server still checks and re-encodes it. */
export async function addRecipePhotoChecked(db: Db, store: BlobStore, input: PhotoWriteScope & { recipeSlug: string; bytes: Uint8Array; personId?: number | null }): Promise<Outcome<{ uid: string; recipeSlug: string }>> {
  if (input.bytes.byteLength === 0) return { ok: false, error: "Choose a photo first." };
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: "That photo is larger than 8 MB." };
  const [recipe] = await db.select({ id: s.recipes.id, kind: s.recipes.kind }).from(s.recipes).where(eq(s.recipes.slug, input.recipeSlug));
  if (!recipe) return { ok: false, error: "Recipe not found." };
  const existing = await db.select({ id: s.photos.id }).from(s.photos).where(and(eq(s.photos.recipeId, recipe.id), owned(input.householdId)));
  if (existing.length >= MAX_PHOTOS_PER_RECIPE) return { ok: false, error: `A recipe keeps up to ${MAX_PHOTOS_PER_RECIPE} photos. Remove one first.` };
  try {
    const { uid } = await writeUploadedPhoto(db, store, { ...input, subject: { kind: "recipe", recipeId: recipe.id }, maxPhotos: MAX_PHOTOS_PER_RECIPE });
    return { ok: true, uid, recipeSlug: input.recipeSlug };
  } catch (e) {
    if (e instanceof PhotoError) return { ok: false, error: e.message };
    throw e;
  }
}

async function recipeSlugOf(db: Db, uid: string, householdId?: string): Promise<string | null | undefined> {
  const [row] = await db.select({ recipeId: s.photos.recipeId }).from(s.photos).where(and(eq(s.photos.uid, uid), owned(householdId)));
  if (!row) return undefined;
  if (row.recipeId === null) return null;
  return (await db.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, row.recipeId)))[0]?.slug ?? null;
}

export async function removePhotoChecked(db: Db, store: BlobStore, uid: string, scope: PhotoWriteScope = {}): Promise<Outcome<{ recipeSlug: string | null }>> {
  if (!isPhotoUid(uid)) return { ok: false, error: "Photo not found." };
  const recipeSlug = await recipeSlugOf(db, uid, scope.householdId);
  if (recipeSlug === undefined) return { ok: false, error: "Photo not found." };
  if (!await deletePhoto(db, store, uid, scope)) return { ok: false, error: "Photo not found." };
  return { ok: true, recipeSlug };
}

export async function makeCoverChecked(db: Db, uid: string, scope: PhotoWriteScope = {}): Promise<Outcome<{ recipeSlug: string | null }>> {
  if (!isPhotoUid(uid)) return { ok: false, error: "Photo not found." };
  const recipeSlug = await recipeSlugOf(db, uid, scope.householdId);
  if (recipeSlug === undefined) return { ok: false, error: "Photo not found." };
  if (!await setCoverPhoto(db, uid, scope)) return { ok: false, error: "Photo not found." };
  return { ok: true, recipeSlug };
}
