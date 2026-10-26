import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { libraryPhotoKeys } from "../photos/keys";
import { LIBRARY_MASTER_PX, PhotoError, processPhoto } from "../photos/process";
import type { BlobRef, HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

/**
 * Library-level photo approvals: one approval, no household, shown to everyone. This module is the ONLY writer of
 * `library_photos` and `library_photo_decisions` (tests/library-photos-writers.test.ts enforces it). A NULL household in
 * `photos` means quarantined operator staging, so these are separate tables. Nothing under scripts/ may import this file:
 * the agent proposes candidates, a person approves them.
 */
export const LIBRARY_PHOTOS_CLASS = "library-photos";
export const LIBRARY_PHOTO_DECISIONS_CLASS = "library-photo-decisions";
/** Most photos one recipe or ingredient keeps in the shared library. */
export const LIBRARY_PHOTO_CAP = 3;

export type LibrarySubjectKind = "recipe" | "ingredient";

export interface LibraryCandidateRef {
  candidateKey: string;
  subjectKind: LibrarySubjectKind;
  subjectSlug: string;
}

export interface LibraryApproveInput extends LibraryCandidateRef {
  origin: "commons" | "openverse";
  bytes: Uint8Array;
  credit: { title: string; author: string; licence: string; licenceUrl?: string | null; sourceUrl: string };
  /** When the licence was last checked against the provider, ISO timestamp. */
  licenceCheckedAt: string | null;
  personId: number | null;
}

export type LibraryApproveResult =
  | { status: "approved"; uid: string; isCover: boolean }
  | { status: "exists"; uid: string }
  | { status: "subject-full" }
  | { status: "unknown-subject" };

type LibraryPhotoRow = typeof s.libraryPhotos.$inferSelect;

async function dropBoth(store: BlobStore, uid: string): Promise<void> {
  const keys = libraryPhotoKeys(uid);
  const results = await Promise.allSettled([store.delete(keys.master), store.delete(keys.thumb)]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Library photo object cleanup failed. Run photos:check.");
}

const subjectWhere = (kind: LibrarySubjectKind, recipeId: number | null, slug: string) =>
  kind === "recipe" ? eq(s.libraryPhotos.recipeId, recipeId!) : eq(s.libraryPhotos.ingredientSlug, slug);

async function resolveRecipeId(tx: Tx | Db, slug: string): Promise<number | undefined> {
  return (await tx.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, slug)))[0]?.id;
}

async function subjectExists(db: Db, ref: LibraryCandidateRef): Promise<{ ok: boolean; recipeId: number | null }> {
  if (ref.subjectKind === "recipe") {
    const id = await resolveRecipeId(db, ref.subjectSlug);
    return { ok: id !== undefined, recipeId: id ?? null };
  }
  const [row] = await db.select({ id: s.ingredients.id }).from(s.ingredients).where(eq(s.ingredients.slug, ref.subjectSlug)).limit(1);
  return { ok: !!row, recipeId: null };
}

/** Serialises writers of one subject, so the cover and the cap are decided one approval at a time. */
async function lockSubject(tx: Tx, kind: LibrarySubjectKind, slug: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`library-photos:${kind}:${slug}`}))`);
}

async function upsertDecision(tx: Tx, ref: LibraryCandidateRef, decision: "approved" | "rejected", at: string, personId: number | null): Promise<void> {
  await tx
    .insert(s.libraryPhotoDecisions)
    .values({ uid: newUid(), candidateKey: ref.candidateKey, subjectKind: ref.subjectKind, subjectSlug: ref.subjectSlug, decision, createdAt: at, updatedAt: at, createdByPersonId: personId })
    .onConflictDoUpdate({
      target: [s.libraryPhotoDecisions.subjectKind, s.libraryPhotoDecisions.subjectSlug, s.libraryPhotoDecisions.candidateKey],
      set: { decision, updatedAt: at },
    });
}

/**
 * Approves one candidate for everyone. The caller has already downloaded the bytes from an allowed host and checked the
 * licence. Image work and blob writes run before the transaction. The transaction takes a per-subject lock, inserts with
 * ON CONFLICT DO NOTHING on the candidate index, and records the approval. Files are deleted again if the transaction
 * fails or loses the race. The first photo of a subject is its cover; a subject keeps up to LIBRARY_PHOTO_CAP photos.
 */
export async function approveLibraryCandidate(db: Db, store: BlobStore, input: LibraryApproveInput): Promise<LibraryApproveResult> {
  const { credit } = input;
  if (!input.candidateKey || !credit.title.trim() || !credit.author.trim() || !credit.licence.trim() || !credit.sourceUrl.trim()) {
    throw new PhotoError("A library photo needs a title, author, licence and source before it can be approved.");
  }
  const subject = await subjectExists(db, input);
  if (!subject.ok) return { status: "unknown-subject" };

  const processed = await processPhoto(input.bytes, { masterPx: LIBRARY_MASTER_PX });
  const uid = newUid();
  const at = nowIso();
  const keys = libraryPhotoKeys(uid);
  try {
    await store.put(keys.master, processed.master, "image/webp");
    await store.put(keys.thumb, processed.thumb, "image/webp");
    const result = await withTx(db, async (tx): Promise<LibraryApproveResult> => {
      await lockSubject(tx, input.subjectKind, input.subjectSlug);
      const existing = await tx.select().from(s.libraryPhotos).where(subjectWhere(input.subjectKind, subject.recipeId, input.subjectSlug)).orderBy(asc(s.libraryPhotos.position));
      const duplicate = existing.find((p) => p.candidateKey === input.candidateKey);
      if (duplicate) return { status: "exists", uid: duplicate.uid };
      if (existing.length >= LIBRARY_PHOTO_CAP) return { status: "subject-full" };
      const isCover = !existing.some((p) => p.isCover);
      const position = existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0;
      const inserted = await tx
        .insert(s.libraryPhotos)
        .values({
          uid, recipeId: subject.recipeId, ingredientSlug: input.subjectKind === "ingredient" ? input.subjectSlug : null,
          origin: input.origin, candidateKey: input.candidateKey, sha256: processed.sha256, width: processed.width, height: processed.height,
          isCover, position, title: credit.title, author: credit.author, licence: credit.licence, sourceUrl: credit.sourceUrl,
          licenceUrl: credit.licenceUrl ?? null, licenceCheckedAt: input.licenceCheckedAt, createdAt: at, updatedAt: at, createdByPersonId: input.personId,
        })
        .onConflictDoNothing(input.subjectKind === "recipe"
          ? { target: [s.libraryPhotos.recipeId, s.libraryPhotos.candidateKey], where: sql`${s.libraryPhotos.recipeId} is not null` }
          : { target: [s.libraryPhotos.ingredientSlug, s.libraryPhotos.candidateKey], where: sql`${s.libraryPhotos.ingredientSlug} is not null` })
        .returning({ uid: s.libraryPhotos.uid });
      if (!inserted.length) {
        const [winner] = await tx.select({ uid: s.libraryPhotos.uid }).from(s.libraryPhotos).where(and(subjectWhere(input.subjectKind, subject.recipeId, input.subjectSlug), eq(s.libraryPhotos.candidateKey, input.candidateKey)));
        return { status: "exists", uid: winner!.uid };
      }
      await upsertDecision(tx, input, "approved", at, input.personId);
      await markChanged(tx, LIBRARY_PHOTOS_CLASS, at);
      await markChanged(tx, LIBRARY_PHOTO_DECISIONS_CLASS, at);
      return { status: "approved", uid, isCover };
    });
    if (result.status !== "approved") await dropBoth(store, uid);
    return result;
  } catch (e) {
    try {
      await dropBoth(store, uid);
    } catch (cleanup) {
      throw new AggregateError([e, cleanup], "Library photo persistence failed and its storage cleanup also failed. Run photos:check before retrying.");
    }
    throw e;
  }
}

/**
 * Records rejections in one transaction. A candidate that already has a live library photo is left alone (remove the
 * photo to reject it). Returns how many decisions were written.
 */
export async function rejectLibraryCandidates(db: Db, items: readonly LibraryCandidateRef[], personId: number | null): Promise<number> {
  const unique = [...new Map(items.map((i) => [`${i.subjectKind}\u0000${i.subjectSlug}\u0000${i.candidateKey}`, i])).values()];
  if (!unique.length) return 0;
  return withTx(db, async (tx) => {
    const at = nowIso();
    let written = 0;
    for (const item of unique) {
      const recipeId = item.subjectKind === "recipe" ? await resolveRecipeId(tx, item.subjectSlug) : null;
      if (item.subjectKind === "recipe" && recipeId === undefined) continue;
      const [live] = await tx.select({ id: s.libraryPhotos.id }).from(s.libraryPhotos).where(and(subjectWhere(item.subjectKind, recipeId ?? null, item.subjectSlug), eq(s.libraryPhotos.candidateKey, item.candidateKey)));
      if (live) continue;
      await upsertDecision(tx, item, "rejected", at, personId);
      written++;
    }
    if (written) await markChanged(tx, LIBRARY_PHOTO_DECISIONS_CLASS, at);
    return written;
  });
}

/**
 * Removes a library photo. If it was the cover, the next photo by position takes over. The candidate is recorded as
 * rejected so it does not return to the review queue. Files go after the commit.
 */
export async function removeLibraryPhoto(db: Db, store: BlobStore, uid: string, personId: number | null): Promise<boolean> {
  const removed = await withTx(db, async (tx) => {
    const row = (await tx.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, uid)))[0];
    if (!row) return false;
    const at = nowIso();
    const kind: LibrarySubjectKind = row.recipeId !== null ? "recipe" : "ingredient";
    const slug = row.recipeId !== null ? ((await tx.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, row.recipeId)))[0]?.slug ?? "") : row.ingredientSlug!;
    await lockSubject(tx, kind, slug);
    await tx.delete(s.libraryPhotos).where(eq(s.libraryPhotos.id, row.id));
    if (row.isCover) {
      const next = (await tx.select({ id: s.libraryPhotos.id }).from(s.libraryPhotos).where(subjectWhere(kind, row.recipeId, slug)).orderBy(asc(s.libraryPhotos.position), asc(s.libraryPhotos.id)))[0];
      if (next) await tx.update(s.libraryPhotos).set({ isCover: true, updatedAt: at }).where(eq(s.libraryPhotos.id, next.id));
    }
    await upsertDecision(tx, { candidateKey: row.candidateKey, subjectKind: kind, subjectSlug: slug }, "rejected", at, personId);
    await markChanged(tx, LIBRARY_PHOTOS_CLASS, at);
    await markChanged(tx, LIBRARY_PHOTO_DECISIONS_CLASS, at);
    return true;
  });
  if (!removed) return false;
  await dropBoth(store, uid);
  return true;
}

/** Makes the photo the cover of its subject. The old cover is unset first because of the partial unique index. */
export async function setLibraryCover(db: Db, uid: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const row = (await tx.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, uid)))[0];
    if (!row) return false;
    if (row.isCover) return true;
    const at = nowIso();
    const siblings = row.recipeId !== null ? eq(s.libraryPhotos.recipeId, row.recipeId) : eq(s.libraryPhotos.ingredientSlug, row.ingredientSlug!);
    await tx.update(s.libraryPhotos).set({ isCover: false, updatedAt: at }).where(and(siblings, eq(s.libraryPhotos.isCover, true)));
    await tx.update(s.libraryPhotos).set({ isCover: true, updatedAt: at }).where(eq(s.libraryPhotos.id, row.id));
    await markChanged(tx, LIBRARY_PHOTOS_CLASS, at);
    return true;
  });
}

/** Takes a rejected candidate back to the review queue. Returns false when it was not rejected. */
export async function undoLibraryRejection(db: Db, item: LibraryCandidateRef): Promise<boolean> {
  return withTx(db, async (tx) => {
    const gone = await tx
      .delete(s.libraryPhotoDecisions)
      .where(and(eq(s.libraryPhotoDecisions.subjectKind, item.subjectKind), eq(s.libraryPhotoDecisions.subjectSlug, item.subjectSlug), eq(s.libraryPhotoDecisions.candidateKey, item.candidateKey), eq(s.libraryPhotoDecisions.decision, "rejected")))
      .returning({ id: s.libraryPhotoDecisions.id });
    if (!gone.length) return false;
    await markChanged(tx, LIBRARY_PHOTO_DECISIONS_CLASS, nowIso());
    return true;
  });
}

// ---- Export and import (not household scoped) ----

const PhotoFileSchema = z.object({
  uid: z.string().min(1),
  subject: z.object({ kind: z.enum(["recipe", "ingredient"]), slug: z.string().min(1) }),
  origin: z.enum(["commons", "openverse"]),
  candidate_key: z.string().min(1),
  sha256: z.string().length(64),
  width: z.number().int(),
  height: z.number().int(),
  is_cover: z.boolean(),
  position: z.number().int(),
  title: z.string(),
  author: z.string(),
  licence: z.string(),
  licence_url: z.string().nullable(),
  licence_checked_at: z.string().nullable(),
  source_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PHOTO_PREFIX = "library-photos/";

async function libraryRows(db: Db): Promise<{ photo: LibraryPhotoRow; kind: LibrarySubjectKind; slug: string }[]> {
  const recipePhotos = await db.select({ photo: s.libraryPhotos, slug: s.recipes.slug }).from(s.libraryPhotos).innerJoin(s.recipes, eq(s.recipes.id, s.libraryPhotos.recipeId));
  const ingredientPhotos = await db.select().from(s.libraryPhotos).where(isNull(s.libraryPhotos.recipeId));
  return [
    ...recipePhotos.map((r) => ({ photo: r.photo, kind: "recipe" as const, slug: r.slug })),
    ...ingredientPhotos.map((photo) => ({ photo, kind: "ingredient" as const, slug: photo.ingredientSlug! })),
  ];
}

export const libraryPhotosClass: HumanDataClass = {
  name: LIBRARY_PHOTOS_CLASS,
  prefix: PHOTO_PREFIX,

  /** One file per photo: `library-photos/recipes/<slug>/<uid>.json` or `.../ingredients/<slug>/<uid>.json`. No ids, no bytes. */
  async exportFiles(db) {
    const files: Record<string, string> = {};
    for (const { photo: p, kind, slug } of await libraryRows(db)) {
      files[`${PHOTO_PREFIX}${kind}s/${slug}/${p.uid}.json`] = stableJson({
        uid: p.uid, subject: { kind, slug }, origin: p.origin, candidate_key: p.candidateKey, sha256: p.sha256, width: p.width, height: p.height,
        is_cover: p.isCover, position: p.position, title: p.title, author: p.author, licence: p.licence, licence_url: p.licenceUrl,
        licence_checked_at: p.licenceCheckedAt, source_url: p.sourceUrl, created_at: p.createdAt, updated_at: p.updatedAt,
      });
    }
    return files;
  },

  /** Adds or updates rows by uid. Bytes are copied separately. Never deletes. */
  async importFiles(db, files, ctx) {
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = PhotoFileSchema.parse(JSON.parse(text));
      let recipeId: number | null = null;
      if (f.subject.kind === "recipe") {
        const id = await ctx.resolveRecipeId(f.subject.slug);
        if (id === undefined) { skipped.push(path); continue; }
        recipeId = id;
      }
      const ingredientSlug = f.subject.kind === "ingredient" ? f.subject.slug : null;
      const values = {
        recipeId, ingredientSlug, origin: f.origin, candidateKey: f.candidate_key, sha256: f.sha256, width: f.width, height: f.height,
        isCover: f.is_cover, position: f.position, title: f.title, author: f.author, licence: f.licence, licenceUrl: f.licence_url,
        licenceCheckedAt: f.licence_checked_at, sourceUrl: f.source_url, createdAt: f.created_at, updatedAt: f.updated_at,
      };
      // One cover per subject: a new cover displaces the old one before the row lands.
      if (f.is_cover) {
        const siblings = recipeId !== null ? eq(s.libraryPhotos.recipeId, recipeId) : eq(s.libraryPhotos.ingredientSlug, ingredientSlug!);
        await db.update(s.libraryPhotos).set({ isCover: false }).where(and(siblings, eq(s.libraryPhotos.isCover, true), sql`${s.libraryPhotos.uid} <> ${f.uid}`));
      }
      const existing = (await db.select({ id: s.libraryPhotos.id }).from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, f.uid)))[0];
      if (existing) await db.update(s.libraryPhotos).set(values).where(eq(s.libraryPhotos.id, existing.id));
      else await db.insert(s.libraryPhotos).values({ ...values, uid: f.uid });
      imported++;
    }
    return { imported, skipped };
  },

  async blobs(db) {
    const refs: BlobRef[] = [];
    for (const p of await db.select({ uid: s.libraryPhotos.uid, sha256: s.libraryPhotos.sha256 }).from(s.libraryPhotos)) {
      const keys = libraryPhotoKeys(p.uid);
      refs.push({ key: keys.master, sha256: p.sha256 }, { key: keys.thumb });
    }
    return refs;
  },

  async hasRecipeData(db, recipeId) {
    const [row] = await db.select({ id: s.libraryPhotos.id }).from(s.libraryPhotos).where(eq(s.libraryPhotos.recipeId, recipeId)).limit(1);
    return !!row;
  },

  /**
   * A slug rename onto an existing recipe: moves the photos across. A photo whose candidate the target already has stays
   * behind (so the old recipe is kept and nothing is lost); the target keeps its own cover.
   */
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    return withTx(db, async (tx) => {
      const moving = await tx.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.recipeId, fromRecipeId)).orderBy(asc(s.libraryPhotos.position), asc(s.libraryPhotos.id));
      const target = await tx.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.recipeId, toRecipeId));
      const taken = new Set(target.map((p) => p.candidateKey));
      let hasCover = target.some((p) => p.isCover);
      let next = target.length ? Math.max(...target.map((p) => p.position)) + 1 : 0;
      const at = nowIso();
      let moved = 0;
      for (const p of moving) {
        if (taken.has(p.candidateKey) || target.length + moved >= LIBRARY_PHOTO_CAP) continue;
        const cover = p.isCover && !hasCover;
        hasCover ||= cover;
        await tx.update(s.libraryPhotos).set({ recipeId: toRecipeId, position: next++, isCover: cover, updatedAt: at }).where(eq(s.libraryPhotos.id, p.id));
        moved++;
      }
      if (moved) await markChanged(tx, LIBRARY_PHOTOS_CLASS, at);
      return moved > 0;
    });
  },
};

const DecisionFileSchema = z.object({
  uid: z.string().min(1),
  candidate_key: z.string().min(1),
  subject_kind: z.enum(["recipe", "ingredient"]),
  subject_slug: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  created_at: z.string(),
  updated_at: z.string(),
});

const DECISION_PREFIX = "library-photo-decisions/";

async function recipeSlug(tx: Db, id: number): Promise<string | undefined> {
  return (await tx.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, id)))[0]?.slug;
}

/** Decisions are keyed by recipe slug, so a rename rewrites them. A decision the new slug already has wins. */
async function rewriteDecisionSlug(db: Db, oldSlug: string, newSlug: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const old = await tx.select().from(s.libraryPhotoDecisions).where(and(eq(s.libraryPhotoDecisions.subjectKind, "recipe"), eq(s.libraryPhotoDecisions.subjectSlug, oldSlug)));
    if (!old.length) return false;
    const at = nowIso();
    const have = new Set((await tx.select({ k: s.libraryPhotoDecisions.candidateKey }).from(s.libraryPhotoDecisions).where(and(eq(s.libraryPhotoDecisions.subjectKind, "recipe"), eq(s.libraryPhotoDecisions.subjectSlug, newSlug)))).map((r) => r.k));
    for (const d of old) {
      if (have.has(d.candidateKey)) await tx.delete(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.id, d.id));
      else await tx.update(s.libraryPhotoDecisions).set({ subjectSlug: newSlug, updatedAt: at }).where(eq(s.libraryPhotoDecisions.id, d.id));
    }
    await markChanged(tx, LIBRARY_PHOTO_DECISIONS_CLASS, at);
    return true;
  });
}

export const libraryPhotoDecisionsClass: HumanDataClass = {
  name: LIBRARY_PHOTO_DECISIONS_CLASS,
  prefix: DECISION_PREFIX,

  async exportFiles(db) {
    const files: Record<string, string> = {};
    for (const d of await db.select().from(s.libraryPhotoDecisions)) {
      files[`${DECISION_PREFIX}${d.subjectKind}s/${d.subjectSlug}/${d.uid}.json`] = stableJson({
        uid: d.uid, candidate_key: d.candidateKey, subject_kind: d.subjectKind, subject_slug: d.subjectSlug, decision: d.decision, created_at: d.createdAt, updated_at: d.updatedAt,
      });
    }
    return files;
  },

  async importFiles(db, files) {
    let imported = 0;
    for (const [, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = DecisionFileSchema.parse(JSON.parse(text));
      const values = { candidateKey: f.candidate_key, subjectKind: f.subject_kind, subjectSlug: f.subject_slug, decision: f.decision, createdAt: f.created_at, updatedAt: f.updated_at };
      const existing = (await db.select({ id: s.libraryPhotoDecisions.id }).from(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.uid, f.uid)))[0];
      if (existing) await db.update(s.libraryPhotoDecisions).set(values).where(eq(s.libraryPhotoDecisions.id, existing.id));
      else await db.insert(s.libraryPhotoDecisions).values({ ...values, uid: f.uid });
      imported++;
    }
    return { imported, skipped: [] };
  },

  async moveRecipe(db, fromRecipeId, toRecipeId) {
    const [from, to] = [await recipeSlug(db, fromRecipeId), await recipeSlug(db, toRecipeId)];
    return from && to ? rewriteDecisionSlug(db, from, to) : false;
  },

  async renameRecipeSlug(db, oldSlug, newSlug) {
    await rewriteDecisionSlug(db, oldSlug, newSlug);
  },
};
