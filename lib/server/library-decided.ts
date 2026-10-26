import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { Candidate, CandidateFile } from "../photos/candidates";
import type { ReviewFilter, SubjectKind } from "./photo-review";
import type { SubjectNames } from "./library-review";

export interface DecidedPhoto {
  uid: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
  origin: "commons" | "openverse";
  isCover: boolean;
}

export interface DecidedSubject {
  kind: SubjectKind;
  slug: string;
  name: string;
  /** Approved library photos, cover first. */
  photos: DecidedPhoto[];
  /** Rejected candidates that are still in the candidate file, so they can be shown and undone. */
  rejected: Candidate[];
}

/**
 * Subjects that have an answer: approved library photos and rejected candidates, for the "Decided" view. Read straight
 * from the tables, not the cached manifest, so a change shows on the next refresh. A rejection whose candidate is no
 * longer in the candidate file is left out because there is nothing to show or undo.
 */
export async function decidedLibraryReview(db: Db, file: CandidateFile, names: SubjectNames, filter: ReviewFilter = {}): Promise<DecidedSubject[]> {
  const rows = await db
    .select({ p: s.libraryPhotos, recipeSlug: s.recipes.slug })
    .from(s.libraryPhotos)
    .leftJoin(s.recipes, eq(s.recipes.id, s.libraryPhotos.recipeId))
    .orderBy(desc(s.libraryPhotos.isCover), asc(s.libraryPhotos.position), asc(s.libraryPhotos.id));
  const decisions = await db.select({ kind: s.libraryPhotoDecisions.subjectKind, slug: s.libraryPhotoDecisions.subjectSlug, key: s.libraryPhotoDecisions.candidateKey })
    .from(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.decision, "rejected"));

  const photos = new Map<string, DecidedPhoto[]>();
  for (const { p, recipeSlug } of rows) {
    const subject = recipeSlug ? `recipe:${recipeSlug}` : `ingredient:${p.ingredientSlug}`; // the subject check constraint guarantees one of the two
    const list = photos.get(subject) ?? [];
    list.push({ uid: p.uid, title: p.title, author: p.author, licence: p.licence, licenceUrl: p.licenceUrl, sourceUrl: p.sourceUrl, origin: p.origin as DecidedPhoto["origin"], isCover: p.isCover });
    photos.set(subject, list);
  }
  const rejectedKeys = new Map<string, Set<string>>();
  for (const d of decisions) {
    const subject = `${d.kind}:${d.slug}`;
    rejectedKeys.set(subject, (rejectedKeys.get(subject) ?? new Set()).add(d.key));
  }

  const q = (filter.q ?? "").trim().toLowerCase();
  const out: DecidedSubject[] = [];
  for (const [kind, nameMap, listed] of [["recipe", names.recipes, file.recipes], ["ingredient", names.ingredients, file.ingredients]] as const) {
    if (filter.kind && filter.kind !== "all" && filter.kind !== kind) continue;
    const slugs = new Set([...nameMap.keys()].filter((slug) => photos.has(`${kind}:${slug}`) || rejectedKeys.has(`${kind}:${slug}`)));
    for (const slug of slugs) {
      const name = nameMap.get(slug)!;
      if (q && !name.toLowerCase().includes(q) && !slug.includes(q)) continue;
      const own = photos.get(`${kind}:${slug}`) ?? [];
      if (filter.onlyWithoutPhoto && own.length > 0) continue;
      const keys = rejectedKeys.get(`${kind}:${slug}`) ?? new Set<string>();
      const rejected = (listed[slug] ?? []).filter((c) => keys.has(c.key));
      if (own.length === 0 && rejected.length === 0) continue;
      out.push({ kind, slug, name, photos: own, rejected });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}
