import { isNotNull } from "drizzle-orm";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { foodLabelKeys, libraryPhotoKeys, photoKeys } from "./keys";

export interface PhotoCheck {
  /** Files in the store that no photo row points at (a crash between the file write and the row). Safe to delete. Covers `photos/`, `library/` and `labels/`. */
  orphans: string[];
  /** Photo rows whose files are missing from the store. A restore without the uploads folder looks like this. */
  missing: { uid: string; keys: string[] }[];
}

/** Compares household and library photo rows with the files in the store. Library files are only ever reported orphan when no library row names them. */
export async function checkPhotos(db: Db, store: BlobStore): Promise<PhotoCheck> {
  const rows = await db.select({ uid: s.photos.uid }).from(s.photos);
  const libraryRows = await db.select({ uid: s.libraryPhotos.uid }).from(s.libraryPhotos);
  const labelRows = (await db.select({ uid: s.householdFoods.labelPhotoUid }).from(s.householdFoods).where(isNotNull(s.householdFoods.labelPhotoUid))).map((r) => ({ uid: r.uid! }));
  const wanted = new Set([
    ...rows.flatMap((r) => Object.values(photoKeys(r.uid))), ...libraryRows.flatMap((r) => Object.values(libraryPhotoKeys(r.uid))),
    ...labelRows.flatMap((r) => Object.values(foodLabelKeys(r.uid))),
  ]);
  const stored = await store.list();
  const have = new Set(stored);
  const absent = (uid: string, keys: { master: string; thumb: string }) => {
    const gone = Object.values(keys).filter((k) => !have.has(k));
    return gone.length ? [{ uid, keys: gone }] : [];
  };
  return {
    orphans: stored.filter((k) => (k.startsWith("photos/") || k.startsWith("library/") || k.startsWith("labels/")) && !wanted.has(k)),
    missing: [...rows.flatMap((r) => absent(r.uid, photoKeys(r.uid))), ...libraryRows.flatMap((r) => absent(r.uid, libraryPhotoKeys(r.uid))), ...labelRows.flatMap((r) => absent(r.uid, foodLabelKeys(r.uid)))],
  };
}
