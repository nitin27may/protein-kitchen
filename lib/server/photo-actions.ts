import { eq } from "drizzle-orm";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { deletePhoto, setCoverPhoto, writeUploadedPhoto } from "../human";
import { MAX_UPLOAD_BYTES, PhotoError } from "../photos/process";
import { isPhotoUid } from "../photos/keys";

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Most photos kept per recipe. A guard against a runaway upload loop, not a product limit people should meet. */
export const MAX_PHOTOS_PER_RECIPE = 12;

/** Validates an upload for a recipe and stores it. The file is already resized on the phone; the server still checks and re-encodes it. */
export async function addRecipePhotoChecked(db: Db, store: BlobStore, input: { recipeSlug: string; bytes: Uint8Array; personId?: number | null }): Promise<Outcome<{ uid: string; recipeSlug: string }>> {
  if (input.bytes.byteLength === 0) return { ok: false, error: "Choose a photo first." };
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: "That photo is larger than 8 MB." };
  const [recipe] = await db.select({ id: s.recipes.id, kind: s.recipes.kind }).from(s.recipes).where(eq(s.recipes.slug, input.recipeSlug));
  if (!recipe) return { ok: false, error: "Recipe not found." };
  const existing = await db.select({ id: s.photos.id }).from(s.photos).where(eq(s.photos.recipeId, recipe.id));
  if (existing.length >= MAX_PHOTOS_PER_RECIPE) return { ok: false, error: `A recipe keeps up to ${MAX_PHOTOS_PER_RECIPE} photos. Remove one first.` };
  try {
    const { uid } = await writeUploadedPhoto(db, store, { subject: { kind: "recipe", recipeId: recipe.id }, bytes: input.bytes, personId: input.personId });
    return { ok: true, uid, recipeSlug: input.recipeSlug };
  } catch (e) {
    if (e instanceof PhotoError) return { ok: false, error: e.message };
    throw e;
  }
}

async function recipeSlugOf(db: Db, uid: string): Promise<string | null | undefined> {
  const [row] = await db.select({ recipeId: s.photos.recipeId }).from(s.photos).where(eq(s.photos.uid, uid));
  if (!row) return undefined;
  if (row.recipeId === null) return null;
  return (await db.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, row.recipeId)))[0]?.slug ?? null;
}

export async function removePhotoChecked(db: Db, store: BlobStore, uid: string): Promise<Outcome<{ recipeSlug: string | null }>> {
  if (!isPhotoUid(uid)) return { ok: false, error: "Photo not found." };
  const recipeSlug = await recipeSlugOf(db, uid);
  if (recipeSlug === undefined) return { ok: false, error: "Photo not found." };
  await deletePhoto(db, store, uid);
  return { ok: true, recipeSlug };
}

export async function makeCoverChecked(db: Db, uid: string): Promise<Outcome<{ recipeSlug: string | null }>> {
  if (!isPhotoUid(uid)) return { ok: false, error: "Photo not found." };
  const recipeSlug = await recipeSlugOf(db, uid);
  if (recipeSlug === undefined) return { ok: false, error: "Photo not found." };
  await setCoverPhoto(db, uid);
  return { ok: true, recipeSlug };
}
