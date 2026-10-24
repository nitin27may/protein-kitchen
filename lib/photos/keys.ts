/** Blob keys for a photo, derived from its uid. The database stores the uid only, never a key or a URL. */
export const photoKeys = (uid: string): { master: string; thumb: string } => ({ master: `photos/${uid}/master.webp`, thumb: `photos/${uid}/thumb.webp` });

export type PhotoVariant = "master" | "thumb";

/** The stable URL a page uses for a photo. On the Neon bucket the same route redirects to a signed link. */
export const photoUrl = (uid: string, variant: PhotoVariant = "master"): string => `/photos/${uid}/${variant}`;

export const isPhotoUid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
