import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx } from "../db/tx";
import * as s from "../db/schema";
import type { HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const SAVED_VIEWS_CLASS = "saved-views";

export interface SavedViewInput {
  list: string;
  name?: string;
  query: string;
  /** Default true: a list's default view replaces the previous one. */
  isDefault?: boolean;
  createdByPersonId?: number | null;
}

/** Creates a saved view, or updates the list's current default in place so its uid stays stable. */
export async function writeSavedView(db: Db, input: SavedViewInput): Promise<{ uid: string }> {
  const at = nowIso();
  const isDefault = input.isDefault ?? true;
  const existing = isDefault
    ? (await db.select().from(s.savedViews).where(and(eq(s.savedViews.list, input.list), eq(s.savedViews.isDefault, true))))[0]
    : undefined;
  const uid = existing?.uid ?? newUid();
  await withTx(db, (tx) => {
    if (existing) {
      tx.update(s.savedViews).set({ query: input.query, name: input.name ?? existing.name, uid, createdAt: existing.createdAt ?? at, updatedAt: at }).where(eq(s.savedViews.id, existing.id)).run();
    } else {
      tx.insert(s.savedViews).values({ list: input.list, name: input.name ?? "Default", query: input.query, isDefault, uid, createdAt: at, updatedAt: at, createdByPersonId: input.createdByPersonId ?? null }).run();
    }
    markChanged(tx, SAVED_VIEWS_CLASS, at);
  });
  return { uid };
}

/** Removes the list's default view. */
export async function clearSavedView(db: Db, list: string): Promise<void> {
  const at = nowIso();
  const existing = (await db.select({ id: s.savedViews.id }).from(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))))[0];
  if (!existing) return;
  await withTx(db, (tx) => {
    tx.delete(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))).run();
    markChanged(tx, SAVED_VIEWS_CLASS, at);
  });
}

const FileSchema = z.object({
  uid: z.string().min(1),
  list: z.string().min(1),
  name: z.string().min(1),
  query: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PREFIX = "saved-views/";

export const savedViewsClass: HumanDataClass = {
  name: SAVED_VIEWS_CLASS,
  prefix: PREFIX,

  async exportFiles(db) {
    const rows = await db.select().from(s.savedViews);
    const files: Record<string, string> = {};
    for (const r of rows) {
      const at = nowIso();
      const uid = r.uid ?? newUid();
      const createdAt = r.createdAt ?? at;
      const updatedAt = r.updatedAt ?? createdAt;
      if (r.uid === null || r.createdAt === null || r.updatedAt === null) {
        await db.update(s.savedViews).set({ uid, createdAt, updatedAt }).where(eq(s.savedViews.id, r.id));
      }
      files[`${PREFIX}${r.list}-${uid}.json`] = stableJson({ uid, list: r.list, name: r.name, query: r.query, is_default: r.isDefault, created_at: createdAt, updated_at: updatedAt });
    }
    return files;
  },

  async importFiles(db, files) {
    let imported = 0;
    for (const [, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = FileSchema.parse(JSON.parse(text));
      const values = { list: f.list, name: f.name, query: f.query, isDefault: f.is_default, createdAt: f.created_at, updatedAt: f.updated_at };
      const existing = (await db.select({ id: s.savedViews.id }).from(s.savedViews).where(eq(s.savedViews.uid, f.uid)))[0];
      // A list has one default. If the file is the default, any other default of that list gives way.
      if (f.is_default) await db.delete(s.savedViews).where(and(eq(s.savedViews.list, f.list), eq(s.savedViews.isDefault, true), or(isNull(s.savedViews.uid), ne(s.savedViews.uid, f.uid))));
      if (existing) await db.update(s.savedViews).set(values).where(eq(s.savedViews.id, existing.id));
      else await db.insert(s.savedViews).values({ ...values, uid: f.uid });
      imported++;
    }
    return { imported, skipped: [] };
  },
};
