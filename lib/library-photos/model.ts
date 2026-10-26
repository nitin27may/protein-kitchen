import type { CreditedPhoto, PhotoView } from "../photos/view";

/**
 * Pure model of the shared library photos: types, an empty value and view builders. No database, server, auth or blob
 * imports, so the signed-out library loaders can use it (tests/access-inventory.test.ts walks their imports).
 */
export interface LibraryPhotoEntry {
  uid: string;
  w: number;
  h: number;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
  origin: "commons" | "openverse";
  /** Candidate index key; the merge uses it to hide a household copy of the same candidate. Never sent to the browser. */
  candidateKey: string;
}

export interface LibrarySubjectPhotos {
  cover: LibraryPhotoEntry;
  /** Every photo of the subject, cover first, then in the order approved. */
  photos: LibraryPhotoEntry[];
}

/** Plain JSON by design: the Next data cache stores it, and a Map would not survive that. */
export interface LibraryPhotoManifest {
  recipes: Record<string, LibrarySubjectPhotos>;
  ingredients: Record<string, LibrarySubjectPhotos>;
}

export const EMPTY_LIBRARY_MANIFEST: LibraryPhotoManifest = Object.freeze({ recipes: Object.freeze({}), ingredients: Object.freeze({}) }) as LibraryPhotoManifest;

export type LibrarySubjectKind = "recipe" | "ingredient";

export const libraryPhotoUrl = (uid: string, variant: "master" | "thumb" = "master"): string => `/library-photos/${uid}/${variant}`;

const subjects = (m: LibraryPhotoManifest, kind: LibrarySubjectKind) => (kind === "recipe" ? m.recipes : m.ingredients);

/** Own-property lookup: a slug such as "constructor" must not find an inherited member. */
export function librarySubject(m: LibraryPhotoManifest, kind: LibrarySubjectKind, slug: string): LibrarySubjectPhotos | undefined {
  const all = subjects(m, kind);
  return Object.hasOwn(all, slug) ? all[slug] : undefined;
}

/** Candidate keys of the library photos of one subject. */
export function libraryCandidateKeys(m: LibraryPhotoManifest, kind: LibrarySubjectKind, slug: string): ReadonlySet<string> {
  return new Set((librarySubject(m, kind, slug)?.photos ?? []).map((p) => p.candidateKey));
}

/** Thumb URL of each subject's library cover, by slug. */
export function libraryCoverUrls(m: LibraryPhotoManifest, kind: LibrarySubjectKind): Map<string, string> {
  return new Map(Object.entries(subjects(m, kind)).map(([slug, s]) => [slug, libraryPhotoUrl(s.cover.uid, "thumb")]));
}

export const libraryView = (e: LibraryPhotoEntry, isCover: boolean): PhotoView => ({
  uid: e.uid, url: libraryPhotoUrl(e.uid, "master"), thumbUrl: libraryPhotoUrl(e.uid, "thumb"), isCover, origin: e.origin, scope: "library",
  width: e.w, height: e.h, title: e.title, author: e.author, licence: e.licence, licenceUrl: e.licenceUrl, sourceUrl: e.sourceUrl,
});

/** The library photos of a subject as page views; the cover is the manifest cover. */
export function libraryViews(m: LibraryPhotoManifest, kind: LibrarySubjectKind, slug: string): PhotoView[] {
  const subject = librarySubject(m, kind, slug);
  return subject ? subject.photos.map((p) => libraryView(p, p.uid === subject.cover.uid)) : [];
}

/** Credit lines for every library photo, recipes and ingredients. */
export function libraryCreditLines(m: LibraryPhotoManifest): CreditedPhoto[] {
  const lines = (kind: LibrarySubjectKind) => Object.entries(subjects(m, kind)).flatMap(([slug, s]) => s.photos.map((p): CreditedPhoto => ({
    uid: p.uid, subjectKind: kind, subjectSlug: slug, scope: "library", title: p.title, author: p.author, licence: p.licence, licenceUrl: p.licenceUrl, sourceUrl: p.sourceUrl,
  })));
  return [...lines("recipe"), ...lines("ingredient")];
}

/** Only web links are rendered as links; the stored value is operator-approved, but a page never trusts a scheme. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}
