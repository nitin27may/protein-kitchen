/** Blob keys for a photo, derived from its uid. The database stores the uid only, never a key or a URL. */
export const photoKeys = (uid: string): { master: string; thumb: string } => ({ master: `photos/${uid}/master.webp`, thumb: `photos/${uid}/thumb.webp` });

/** Blob keys for a library (shared, household-free) photo. Kept under their own prefix so a household reset never reaches them. */
export const libraryPhotoKeys = (uid: string): { master: string; thumb: string } => ({ master: `library/${uid}/master.webp`, thumb: `library/${uid}/thumb.webp` });

export type PhotoVariant = "master" | "thumb";

/** Stable authenticated photo delivery; cloud requests are signed server-side, not exposed as browser bearer URLs. */
export const photoUrl = (uid: string, variant: PhotoVariant = "master"): string => `/photos/${uid}/${variant}`;

export const isPhotoUid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
