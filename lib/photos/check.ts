import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { photoKeys } from "./keys";

export interface PhotoCheck {
  /** Files in the store that no photo row points at (a crash between the file write and the row). Safe to delete. */
  orphans: string[];
  /** Photo rows whose files are missing from the store. A restore without the uploads folder looks like this. */
  missing: { uid: string; keys: string[] }[];
}

/** Compares the photo rows with the files in the store. */
export async function checkPhotos(db: Db, store: BlobStore): Promise<PhotoCheck> {
  const rows = await db.select({ uid: s.photos.uid }).from(s.photos);
  const wanted = new Set(rows.flatMap((r) => Object.values(photoKeys(r.uid))));
  const stored = await store.list();
  const have = new Set(stored);
  return {
    orphans: stored.filter((k) => k.startsWith("photos/") && !wanted.has(k)),
    missing: rows.flatMap((r) => {
      const keys = Object.values(photoKeys(r.uid)).filter((k) => !have.has(k));
      return keys.length ? [{ uid: r.uid, keys }] : [];
    }),
  };
}
