import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx } from "../db/tx";
import * as s from "../db/schema";
import type { HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const FEEDBACK_CLASS = "recipe-feedback";

export interface FeedbackPatch {
  favourite?: boolean;
  banned?: boolean;
  rating?: number | null;
  tested?: boolean;
  notes?: string | null;
}

type FeedbackRow = typeof s.recipeFeedback.$inferSelect;

/** True when a person has set anything on the row. Untouched rows exist for every recipe and are not exported. */
export function isTouched(r: Pick<FeedbackRow, "status" | "rating" | "favourite" | "banned" | "notes" | "testedAt">): boolean {
  return r.rating !== null || r.favourite || r.banned || r.notes !== null || r.status === "tested" || r.testedAt !== null;
}

/**
 * The only writer of recipe feedback. Same rules as the old setRecipeFeedback action: giving a rating marks the
 * recipe tested; `tested` toggles status and tested_at. Also stamps updated_at, fills uid and created_at on first
 * touch, and marks the data class changed in the same transaction.
 */
export async function writeRecipeFeedback(db: Db, recipeId: number, patch: FeedbackPatch): Promise<void> {
  if (patch.rating !== undefined && patch.rating !== null && (!Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > 5)) {
    throw new RangeError("rating must be a whole number from 1 to 5");
  }
  const at = nowIso();
  const set: Partial<typeof s.recipeFeedback.$inferInsert> = {};
  if (patch.favourite !== undefined) set.favourite = patch.favourite;
  if (patch.banned !== undefined) set.banned = patch.banned;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.rating !== undefined) {
    set.rating = patch.rating;
    if (patch.rating !== null) {
      set.status = "tested";
      set.testedAt = at;
    }
  }
  if (patch.tested !== undefined) {
    set.status = patch.tested ? "tested" : "draft";
    set.testedAt = patch.tested ? at : null;
  }

  const existing = (await db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, recipeId)))[0];
  const stamps = { uid: existing?.uid ?? newUid(), createdAt: existing?.createdAt ?? at, updatedAt: at };

  await withTx(db, (tx) => {
    if (existing) tx.update(s.recipeFeedback).set({ ...set, ...stamps }).where(eq(s.recipeFeedback.recipeId, recipeId)).run();
    else tx.insert(s.recipeFeedback).values({ recipeId, ...set, ...stamps }).run();
    markChanged(tx, FEEDBACK_CLASS, at);
  });
}

// ---- export / import ----

const FileSchema = z.object({
  slug: z.string().min(1),
  uid: z.string().min(1),
  status: z.enum(["draft", "tested"]),
  rating: z.number().int().min(1).max(5).nullable(),
  favourite: z.boolean(),
  banned: z.boolean(),
  notes: z.string().nullable(),
  tested_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PREFIX = "feedback/";

export const feedbackClass: HumanDataClass = {
  name: FEEDBACK_CLASS,
  prefix: PREFIX,

  async exportFiles(db) {
    const rows = await db
      .select({ r: s.recipeFeedback, slug: s.recipes.slug })
      .from(s.recipeFeedback)
      .innerJoin(s.recipes, eq(s.recipes.id, s.recipeFeedback.recipeId));
    const files: Record<string, string> = {};
    for (const { r, slug } of rows.sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
      if (!isTouched(r)) continue;
      // Rows written before uid and timestamps existed get them now, once, and keep them.
      const at = nowIso();
      const uid = r.uid ?? newUid();
      const createdAt = r.createdAt ?? r.testedAt ?? at;
      const updatedAt = r.updatedAt ?? createdAt;
      if (r.uid === null || r.createdAt === null || r.updatedAt === null) {
        await db.update(s.recipeFeedback).set({ uid, createdAt, updatedAt }).where(eq(s.recipeFeedback.recipeId, r.recipeId));
      }
      files[`${PREFIX}${slug}.json`] = stableJson({
        slug, uid, status: r.status, rating: r.rating, favourite: r.favourite, banned: r.banned,
        notes: r.notes, tested_at: r.testedAt, created_at: createdAt, updated_at: updatedAt,
      });
    }
    return files;
  },

  async importFiles(db, files, ctx) {
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = FileSchema.parse(JSON.parse(text));
      const recipeId = await ctx.resolveRecipeId(f.slug);
      if (recipeId === undefined) { skipped.push(path); continue; }
      const values = { status: f.status, rating: f.rating, favourite: f.favourite, banned: f.banned, notes: f.notes, testedAt: f.tested_at, uid: f.uid, createdAt: f.created_at, updatedAt: f.updated_at };
      const existing = (await db.select({ id: s.recipeFeedback.recipeId }).from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, recipeId)))[0];
      if (existing) await db.update(s.recipeFeedback).set(values).where(eq(s.recipeFeedback.recipeId, recipeId));
      else await db.insert(s.recipeFeedback).values({ recipeId, ...values });
      imported++;
    }
    return { imported, skipped };
  },

  async hasRecipeData(db, recipeId) {
    const row = (await db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, recipeId)))[0];
    return !!row && isTouched(row);
  },

  /** A slug rename: moves the human fields to the new recipe row unless that row already has its own. */
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    const from = (await db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, fromRecipeId)))[0];
    if (!from || !isTouched(from)) return false;
    const to = (await db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.recipeId, toRecipeId)))[0];
    if (to && isTouched(to)) return false;
    const at = nowIso();
    const uid = from.uid ?? newUid();
    await withTx(db, (tx) => {
      // The uid is unique, so release it on the old row before the new row takes it.
      tx.update(s.recipeFeedback).set({ status: "draft", rating: null, favourite: false, banned: false, notes: null, testedAt: null, uid: null, updatedAt: at }).where(eq(s.recipeFeedback.recipeId, fromRecipeId)).run();
      const values = { status: from.status, rating: from.rating, favourite: from.favourite, banned: from.banned, notes: from.notes, testedAt: from.testedAt, uid, createdAt: from.createdAt ?? at, updatedAt: at, createdByPersonId: from.createdByPersonId };
      if (to) tx.update(s.recipeFeedback).set(values).where(eq(s.recipeFeedback.recipeId, toRecipeId)).run();
      else tx.insert(s.recipeFeedback).values({ recipeId: toRecipeId, ...values }).run();
      markChanged(tx, FEEDBACK_CLASS, at);
    });
    return true;
  },
};
