import { and, asc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import { photoKeys } from "../photos/keys";
import { processPhoto } from "../photos/process";
import type { BlobRef, HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const PHOTOS_CLASS = "photos";
export const PHOTO_DECISIONS_CLASS = "photo-decisions";

export type PhotoSubject = { kind: "recipe"; recipeId: number } | { kind: "ingredient"; slug: string };

export interface PhotoCredit {
  title?: string | null;
  author?: string | null;
  licence?: string | null;
  licenceUrl?: string | null;
  sourceUrl?: string | null;
}

type PhotoRow = typeof s.photos.$inferSelect;

const subjectWhere = (subject: PhotoSubject) => (subject.kind === "recipe" ? eq(s.photos.recipeId, subject.recipeId) : eq(s.photos.ingredientSlug, subject.slug));

async function putBoth(store: BlobStore, uid: string, master: Uint8Array, thumb: Uint8Array): Promise<void> {
  const keys = photoKeys(uid);
  await store.put(keys.master, master, "image/webp");
  await store.put(keys.thumb, thumb, "image/webp");
}

async function dropBoth(store: BlobStore, uid: string): Promise<void> {
  const keys = photoKeys(uid);
  await store.delete(keys.master);
  await store.delete(keys.thumb);
}

interface NewPhoto {
  subject: PhotoSubject;
  origin: "upload" | "commons" | "openverse";
  bytes: Uint8Array;
  credit?: PhotoCredit;
  candidateKey?: string;
  personId?: number | null;
  /** Written with the photo in the same transaction (the approval of a candidate). */
  decision?: { candidateKey: string; kind: "recipe" | "ingredient"; slug: string };
}

/**
 * Processes the image (location data dropped, WebP, capped), stores the bytes, then records the row. Image work and
 * blob writes run before the transaction, because a transaction callback cannot await. If the transaction fails the
 * blobs are removed again. Own uploads take the cover place from an approved candidate; a candidate never replaces an
 * own photo.
 */
async function insertPhoto(db: Db, store: BlobStore, input: NewPhoto): Promise<{ id: number; uid: string }> {
  const processed = await processPhoto(input.bytes);
  const uid = newUid();
  await putBoth(store, uid, processed.master, processed.thumb);
  const at = nowIso();
  try {
    const existing = await db.select().from(s.photos).where(subjectWhere(input.subject)).orderBy(asc(s.photos.position));
    const cover = existing.find((p) => p.isCover);
    const becomesCover = !cover || (input.origin === "upload" && cover.origin !== "upload");
    const position = existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0;
    const credit = input.credit ?? {};
    const id = await withTx(db, (tx) => {
      if (becomesCover && cover) tx.update(s.photos).set({ isCover: false, updatedAt: at }).where(eq(s.photos.id, cover.id)).run();
      const row = tx
        .insert(s.photos)
        .values({
          uid,
          recipeId: input.subject.kind === "recipe" ? input.subject.recipeId : null,
          ingredientSlug: input.subject.kind === "ingredient" ? input.subject.slug : null,
          origin: input.origin,
          candidateKey: input.candidateKey ?? null,
          sha256: processed.sha256,
          width: processed.width,
          height: processed.height,
          isCover: becomesCover,
          position,
          title: credit.title ?? null,
          author: credit.author ?? null,
          licence: credit.licence ?? null,
          licenceUrl: credit.licenceUrl ?? null,
          sourceUrl: credit.sourceUrl ?? null,
          createdAt: at,
          updatedAt: at,
          createdByPersonId: input.personId ?? null,
        })
        .returning({ id: s.photos.id })
        .get();
      markChanged(tx, PHOTOS_CLASS, at);
      if (input.decision) {
        upsertDecision(tx, input.decision.candidateKey, input.decision.kind, input.decision.slug, "approved", at, input.personId ?? null);
        markChanged(tx, PHOTO_DECISIONS_CLASS, at);
      }
      return row.id;
    });
    return { id, uid };
  } catch (e) {
    await dropBoth(store, uid);
    throw e;
  }
}

type TxLike = Parameters<Parameters<Db["transaction"]>[0]>[0];

function upsertDecision(tx: TxLike, candidateKey: string, kind: "recipe" | "ingredient", slug: string, decision: "approved" | "rejected", at: string, personId: number | null): void {
  const existing = tx
    .select({ id: s.photoDecisions.id })
    .from(s.photoDecisions)
    .where(and(eq(s.photoDecisions.candidateKey, candidateKey), eq(s.photoDecisions.subjectKind, kind), eq(s.photoDecisions.subjectSlug, slug)))
    .get();
  if (existing) tx.update(s.photoDecisions).set({ decision, updatedAt: at }).where(eq(s.photoDecisions.id, existing.id)).run();
  else tx.insert(s.photoDecisions).values({ uid: newUid(), candidateKey, subjectKind: kind, subjectSlug: slug, decision, createdAt: at, updatedAt: at, createdByPersonId: personId }).run();
}

/** A photo the person took. The only writer of uploads. */
export async function writeUploadedPhoto(db: Db, store: BlobStore, input: { subject: PhotoSubject; bytes: Uint8Array; title?: string | null; personId?: number | null }): Promise<{ id: number; uid: string }> {
  return insertPhoto(db, store, { subject: input.subject, origin: "upload", bytes: input.bytes, credit: { title: input.title ?? null }, personId: input.personId });
}

/**
 * Approves a candidate photo whose bytes the caller has already downloaded from an allowed host. Records the credit and
 * the approval together. Approving a candidate twice returns the photo already made.
 */
export async function approveCandidate(
  db: Db,
  store: BlobStore,
  input: { candidateKey: string; provider: "commons" | "openverse"; subject: PhotoSubject; subjectSlug: string; bytes: Uint8Array; credit: PhotoCredit; personId?: number | null },
): Promise<{ id: number; uid: string }> {
  const existing = (await db.select().from(s.photos).where(and(eq(s.photos.candidateKey, input.candidateKey), subjectWhere(input.subject))))[0];
  if (existing) return { id: existing.id, uid: existing.uid };
  return insertPhoto(db, store, {
    subject: input.subject,
    origin: input.provider,
    bytes: input.bytes,
    credit: input.credit,
    candidateKey: input.candidateKey,
    personId: input.personId,
    decision: { candidateKey: input.candidateKey, kind: input.subject.kind, slug: input.subjectSlug },
  });
}

/** Marks a candidate rejected. It never comes back to the review queue. */
export async function rejectCandidate(db: Db, input: { candidateKey: string; kind: "recipe" | "ingredient"; slug: string; personId?: number | null }): Promise<void> {
  const at = nowIso();
  await withTx(db, (tx) => {
    upsertDecision(tx, input.candidateKey, input.kind, input.slug, "rejected", at, input.personId ?? null);
    markChanged(tx, PHOTO_DECISIONS_CLASS, at);
  });
}

/** Makes the photo the cover of its recipe or ingredient. Returns false if there is no such photo. */
export async function setCoverPhoto(db: Db, uid: string): Promise<boolean> {
  const row = (await db.select().from(s.photos).where(eq(s.photos.uid, uid)))[0];
  if (!row) return false;
  if (row.isCover) return true;
  const at = nowIso();
  const siblings = row.recipeId !== null ? eq(s.photos.recipeId, row.recipeId) : eq(s.photos.ingredientSlug, row.ingredientSlug!);
  await withTx(db, (tx) => {
    tx.update(s.photos).set({ isCover: false, updatedAt: at }).where(and(siblings, eq(s.photos.isCover, true))).run();
    tx.update(s.photos).set({ isCover: true, updatedAt: at }).where(eq(s.photos.id, row.id)).run();
    markChanged(tx, PHOTOS_CLASS, at);
  });
  return true;
}

/**
 * Removes a photo and its bytes. If it was the cover, the next photo takes over. A removed candidate is marked
 * rejected, so it does not return to the review queue.
 */
export async function deletePhoto(db: Db, store: BlobStore, uid: string): Promise<boolean> {
  const row = (await db.select().from(s.photos).where(eq(s.photos.uid, uid)))[0];
  if (!row) return false;
  const at = nowIso();
  const siblings = row.recipeId !== null ? eq(s.photos.recipeId, row.recipeId) : eq(s.photos.ingredientSlug, row.ingredientSlug!);
  await withTx(db, (tx) => {
    tx.delete(s.photos).where(eq(s.photos.id, row.id)).run();
    if (row.isCover) {
      const next = tx.select({ id: s.photos.id }).from(s.photos).where(siblings).orderBy(asc(s.photos.position), asc(s.photos.id)).get();
      if (next) tx.update(s.photos).set({ isCover: true, updatedAt: at }).where(eq(s.photos.id, next.id)).run();
    }
    markChanged(tx, PHOTOS_CLASS, at);
    if (row.candidateKey) {
      const kind = row.recipeId !== null ? "recipe" : "ingredient";
      const slug = row.recipeId !== null ? (tx.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, row.recipeId)).get()?.slug ?? "") : row.ingredientSlug!;
      upsertDecision(tx, row.candidateKey, kind, slug, "rejected", at, null);
      markChanged(tx, PHOTO_DECISIONS_CLASS, at);
    }
  });
  await dropBoth(store, uid);
  return true;
}

// ---- Export and import ----

const PhotoFileSchema = z.object({
  uid: z.string().min(1),
  subject: z.object({ kind: z.enum(["recipe", "ingredient"]), slug: z.string().min(1) }),
  origin: z.enum(["upload", "commons", "openverse"]),
  candidate_key: z.string().nullable(),
  sha256: z.string().length(64),
  width: z.number().int(),
  height: z.number().int(),
  is_cover: z.boolean(),
  position: z.number().int(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  licence: z.string().nullable(),
  licence_url: z.string().nullable(),
  source_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PHOTO_PREFIX = "photos/";

async function photoRows(db: Db): Promise<{ photo: PhotoRow; subject: { kind: "recipe" | "ingredient"; slug: string } }[]> {
  const recipePhotos = await db.select({ photo: s.photos, slug: s.recipes.slug }).from(s.photos).innerJoin(s.recipes, eq(s.recipes.id, s.photos.recipeId));
  const ingredientPhotos = await db.select().from(s.photos).where(isNull(s.photos.recipeId));
  return [
    ...recipePhotos.map((r) => ({ photo: r.photo, subject: { kind: "recipe" as const, slug: r.slug } })),
    ...ingredientPhotos.map((photo) => ({ photo, subject: { kind: "ingredient" as const, slug: photo.ingredientSlug! } })),
  ];
}

export const photosClass: HumanDataClass = {
  name: PHOTOS_CLASS,
  prefix: PHOTO_PREFIX,

  /** One file per photo: `photos/recipes/<slug>/<uid>.json` or `photos/ingredients/<slug>/<uid>.json`. No database ids, no bytes. */
  async exportFiles(db) {
    const files: Record<string, string> = {};
    for (const { photo: p, subject } of await photoRows(db)) {
      const folder = subject.kind === "recipe" ? "recipes" : "ingredients";
      files[`${PHOTO_PREFIX}${folder}/${subject.slug}/${p.uid}.json`] = stableJson({
        uid: p.uid, subject, origin: p.origin, candidate_key: p.candidateKey, sha256: p.sha256, width: p.width, height: p.height,
        is_cover: p.isCover, position: p.position, title: p.title, author: p.author, licence: p.licence, licence_url: p.licenceUrl,
        source_url: p.sourceUrl, created_at: p.createdAt, updated_at: p.updatedAt,
      });
    }
    return files;
  },

  /** Adds or updates photo rows by uid. The bytes are copied separately (`copyHumanBlobs`). Never deletes. */
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
      const values = {
        recipeId, ingredientSlug: f.subject.kind === "ingredient" ? f.subject.slug : null, origin: f.origin, candidateKey: f.candidate_key,
        sha256: f.sha256, width: f.width, height: f.height, isCover: f.is_cover, position: f.position, title: f.title, author: f.author,
        licence: f.licence, licenceUrl: f.licence_url, sourceUrl: f.source_url, createdAt: f.created_at, updatedAt: f.updated_at,
      };
      const existing = (await db.select({ id: s.photos.id }).from(s.photos).where(eq(s.photos.uid, f.uid)))[0];
      if (existing) await db.update(s.photos).set(values).where(eq(s.photos.id, existing.id));
      else await db.insert(s.photos).values({ ...values, uid: f.uid });
      imported++;
    }
    return { imported, skipped };
  },

  async blobs(db) {
    const refs: BlobRef[] = [];
    for (const p of await db.select({ uid: s.photos.uid, sha256: s.photos.sha256 }).from(s.photos)) {
      const keys = photoKeys(p.uid);
      refs.push({ key: keys.master, sha256: p.sha256 }, { key: keys.thumb });
    }
    return refs;
  },

  async hasRecipeData(db, recipeId) {
    const [row] = await db.select({ id: s.photos.id }).from(s.photos).where(eq(s.photos.recipeId, recipeId)).limit(1);
    return !!row;
  },

  /** A slug rename: moves the photos to the new recipe row. The cover of the new row stays the cover unless it had none. */
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    const moving = await db.select().from(s.photos).where(eq(s.photos.recipeId, fromRecipeId)).orderBy(asc(s.photos.position), asc(s.photos.id));
    if (moving.length === 0) return false;
    const [top] = await db.select({ m: max(s.photos.position) }).from(s.photos).where(eq(s.photos.recipeId, toRecipeId));
    const hasCover = !!(await db.select({ id: s.photos.id }).from(s.photos).where(and(eq(s.photos.recipeId, toRecipeId), eq(s.photos.isCover, true))))[0];
    const start = top?.m === null || top?.m === undefined ? 0 : Number(top.m) + 1;
    const at = nowIso();
    await withTx(db, (tx) => {
      moving.forEach((p, i) => {
        tx.update(s.photos).set({ recipeId: toRecipeId, position: start + i, isCover: hasCover ? false : p.isCover, updatedAt: at }).where(eq(s.photos.id, p.id)).run();
      });
      markChanged(tx, PHOTOS_CLASS, at);
    });
    return true;
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

const DECISION_PREFIX = "photo-decisions/";

export const photoDecisionsClass: HumanDataClass = {
  name: PHOTO_DECISIONS_CLASS,
  prefix: DECISION_PREFIX,

  async exportFiles(db) {
    const files: Record<string, string> = {};
    for (const d of await db.select().from(s.photoDecisions)) {
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
      const existing = (await db.select({ id: s.photoDecisions.id }).from(s.photoDecisions).where(eq(s.photoDecisions.uid, f.uid)))[0];
      if (existing) await db.update(s.photoDecisions).set(values).where(eq(s.photoDecisions.id, existing.id));
      else await db.insert(s.photoDecisions).values({ ...values, uid: f.uid });
      imported++;
    }
    return { imported, skipped: [] };
  },
};
