import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import { writeRecipeFeedback, type FeedbackPatch } from "./feedback";
import type { HumanDataClass } from "./registry";
import { personKey } from "./routines";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const PERSONAL_FEEDBACK_CLASS = "personal-recipe-feedback";
export const FeedbackInput = z.object({
  favourite: z.boolean().optional(), rating: z.number().int().min(1).max(5).nullable().optional(),
  banned: z.boolean().optional(), tested: z.boolean().optional(), notes: z.string().max(2000).nullable().optional(),
}).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), "Choose a feedback change.");

function peopleByKey(people: Pick<typeof s.people.$inferSelect, "id" | "name" | "birthDate">[]) {
  const keys = new Map<string, number | undefined>();
  for (const person of people) {
    const key = personKey(person.name, person.birthDate);
    keys.set(key, keys.has(key) ? undefined : person.id);
  }
  return keys;
}

/** Personal choices and their household tested/notes changes commit as one operation. */
export async function writePersonalRecipeFeedback(db: Db, personId: number, recipeId: number, input: FeedbackPatch) {
  const patch = FeedbackInput.parse(input);
  await withTx(db, async (tx) => {
    if (patch.favourite !== undefined || patch.rating !== undefined) {
      const at = nowIso();
      await tx.insert(s.personRecipeFeedback).values({
        personId, recipeId, rating: patch.rating, favourite: patch.favourite,
        uid: newUid(), createdAt: at, updatedAt: at, createdByPersonId: personId,
      }).onConflictDoUpdate({
        target: [s.personRecipeFeedback.personId, s.personRecipeFeedback.recipeId],
        set: { rating: patch.rating, favourite: patch.favourite, updatedAt: at },
      });
      await markChanged(tx, PERSONAL_FEEDBACK_CLASS, at);
    }
    const shared = {
      banned: patch.banned, notes: patch.notes,
      tested: patch.tested ?? (patch.rating !== undefined && patch.rating !== null ? true : undefined),
    };
    if (Object.values(shared).some((value) => value !== undefined)) await writeRecipeFeedback(tx, recipeId, shared);
  });
}

export async function deletePersonalFeedbackForPerson(db: Db, personId: number): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.delete(s.personRecipeFeedback).where(eq(s.personRecipeFeedback.personId, personId));
    await markChanged(tx, PERSONAL_FEEDBACK_CLASS, nowIso());
  });
}

export async function resetPersonalFeedback(db: Db): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.delete(s.personRecipeFeedback);
    await markChanged(tx, PERSONAL_FEEDBACK_CLASS, nowIso());
  });
}

const Entry = z.object({
  slug: z.string().min(1), uid: z.string().min(1), rating: z.number().int().min(1).max(5).nullable(),
  favourite: z.boolean(), created_at: z.string(), updated_at: z.string(),
});
const File = z.object({ person: z.string().regex(/^p-[a-f0-9]{16}$/), feedback: z.array(Entry) });
const PREFIX = "personal-feedback/";

export const personalFeedbackClass: HumanDataClass = {
  name: PERSONAL_FEEDBACK_CLASS, prefix: PREFIX,
  async exportFiles(db) {
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people);
    const byKey = peopleByKey(people);
    const rows = await db.select({
      row: s.personRecipeFeedback, slug: s.recipes.slug, name: s.people.name, birthDate: s.people.birthDate,
    }).from(s.personRecipeFeedback).innerJoin(s.recipes, eq(s.recipes.id, s.personRecipeFeedback.recipeId))
      .innerJoin(s.people, eq(s.people.id, s.personRecipeFeedback.personId));
    const groups = new Map<string, z.infer<typeof Entry>[]>();
    for (const { row, slug, name, birthDate } of rows) {
      const key = personKey(name, birthDate);
      if (byKey.get(key) === undefined) throw new Error("Personal feedback export cannot match ambiguous profile keys.");
      const entries = groups.get(key) ?? [];
      entries.push({ slug, uid: row.uid, rating: row.rating, favourite: row.favourite, created_at: row.createdAt, updated_at: row.updatedAt });
      groups.set(key, entries);
    }
    return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => [
      `${PREFIX}${key}.json`, stableJson({ person: key, feedback: entries.sort((a, b) => a.slug.localeCompare(b.slug)) }),
    ]));
  },
  async importFiles(db, files, ctx) {
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people);
    const byKey = peopleByKey(people);
    const writes: (typeof s.personRecipeFeedback.$inferInsert)[] = [];
    const skipped: string[] = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      const file = File.parse(JSON.parse(text));
      if (path !== `${PREFIX}${file.person}.json`) throw new Error("Personal feedback file does not match its person key.");
      const personId = byKey.get(file.person);
      if (personId === undefined) { skipped.push(path); continue; }
      for (const entry of file.feedback) {
        const recipeId = await ctx.resolveRecipeId(entry.slug);
        if (recipeId === undefined) { skipped.push(`${path}#${entry.slug}`); continue; }
        writes.push({
          personId, recipeId, uid: entry.uid, rating: entry.rating, favourite: entry.favourite,
          createdAt: entry.created_at, updatedAt: entry.updated_at, createdByPersonId: personId,
        });
      }
    }
    await withTx(db, async (tx) => {
      for (const row of writes) await tx.insert(s.personRecipeFeedback).values(row).onConflictDoUpdate({
        target: [s.personRecipeFeedback.personId, s.personRecipeFeedback.recipeId],
        set: { uid: row.uid, rating: row.rating, favourite: row.favourite, createdAt: row.createdAt, updatedAt: row.updatedAt },
      });
    });
    return { imported: writes.length, skipped };
  },
  async hasRecipeData(db, recipeId) {
    return (await db.select({ id: s.personRecipeFeedback.personId }).from(s.personRecipeFeedback)
      .where(eq(s.personRecipeFeedback.recipeId, recipeId)).limit(1)).length > 0;
  },
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    return withTx(db, async (tx) => {
      const rows = await tx.select().from(s.personRecipeFeedback).where(eq(s.personRecipeFeedback.recipeId, fromRecipeId));
      let moved = false;
      for (const row of rows) {
        const [existing] = await tx.select({ id: s.personRecipeFeedback.personId }).from(s.personRecipeFeedback)
          .where(and(eq(s.personRecipeFeedback.recipeId, toRecipeId), eq(s.personRecipeFeedback.personId, row.personId)));
        if (existing) continue;
        await tx.update(s.personRecipeFeedback).set({ recipeId: toRecipeId, updatedAt: nowIso() })
          .where(and(eq(s.personRecipeFeedback.recipeId, fromRecipeId), eq(s.personRecipeFeedback.personId, row.personId)));
        moved = true;
      }
      if (moved) await markChanged(tx, PERSONAL_FEEDBACK_CLASS, nowIso());
      return moved;
    });
  },
};
