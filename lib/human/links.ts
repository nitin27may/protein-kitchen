import { asc, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx } from "../db/tx";
import * as s from "../db/schema";
import { LINK_KINDS } from "../links/types";
import type { LinkKind } from "../links/types";
import type { HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

export const LINKS_CLASS = "recipe-links";

/** What a link row stores. The caller has already validated and normalised every field (see lib/links/url.ts). */
export interface LinkRowInput {
  partSlug?: string | null;
  stepNo?: number | null;
  kind: LinkKind;
  url: string;
  title: string;
  source?: string | null;
  startSec?: number | null;
}

type LinkRow = typeof s.recipeLinks.$inferSelect;

/** Adds a link at the end of the recipe's list. The only writer of new links. */
export async function writeLink(db: Db, recipeId: number, input: LinkRowInput, personId?: number | null): Promise<{ id: number; uid: string }> {
  const at = nowIso();
  const uid = newUid();
  const [top] = await db.select({ m: max(s.recipeLinks.position) }).from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, recipeId));
  const position = top?.m === null || top?.m === undefined ? 0 : Number(top.m) + 1;
  const id = await withTx(db, (tx) => {
    const row = tx
      .insert(s.recipeLinks)
      .values({
        uid,
        recipeId,
        partSlug: input.partSlug ?? null,
        stepNo: input.stepNo ?? null,
        kind: input.kind,
        url: input.url,
        title: input.title,
        source: input.source ?? null,
        startSec: input.startSec ?? null,
        position,
        createdAt: at,
        updatedAt: at,
        createdByPersonId: personId ?? null,
      })
      .returning({ id: s.recipeLinks.id })
      .get();
    markChanged(tx, LINKS_CLASS, at);
    return row.id;
  });
  return { id, uid };
}

/** Changes the fields in `patch`; the uid, position and created_at stay. Returns false if the link does not exist. */
export async function updateLinkRow(db: Db, id: number, patch: Partial<LinkRowInput>): Promise<boolean> {
  const existing = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(eq(s.recipeLinks.id, id)))[0];
  if (!existing) return false;
  const at = nowIso();
  const set: Partial<typeof s.recipeLinks.$inferInsert> = { updatedAt: at };
  if (patch.partSlug !== undefined) set.partSlug = patch.partSlug;
  if (patch.stepNo !== undefined) set.stepNo = patch.stepNo;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.source !== undefined) set.source = patch.source;
  if (patch.startSec !== undefined) set.startSec = patch.startSec;
  await withTx(db, (tx) => {
    tx.update(s.recipeLinks).set(set).where(eq(s.recipeLinks.id, id)).run();
    markChanged(tx, LINKS_CLASS, at);
  });
  return true;
}

export async function deleteLinkRow(db: Db, id: number): Promise<boolean> {
  const existing = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(eq(s.recipeLinks.id, id)))[0];
  if (!existing) return false;
  const at = nowIso();
  await withTx(db, (tx) => {
    tx.delete(s.recipeLinks).where(eq(s.recipeLinks.id, id)).run();
    markChanged(tx, LINKS_CLASS, at);
  });
  return true;
}

/**
 * Puts the recipe's links in the given order. Ids that do not belong to the recipe are ignored; links not named keep
 * their relative order after the named ones. Positions are rewritten as 0, 1, 2, and only rows that moved change.
 */
export async function reorderLinks(db: Db, recipeId: number, orderedIds: number[]): Promise<void> {
  const rows = await db.select().from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, recipeId)).orderBy(asc(s.recipeLinks.position), asc(s.recipeLinks.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const named = [...new Set(orderedIds)].filter((id) => byId.has(id));
  const rest = rows.filter((r) => !named.includes(r.id)).map((r) => r.id);
  const order = [...named, ...rest];
  const changed = order.filter((id, index) => byId.get(id)!.position !== index);
  if (changed.length === 0) return;
  const at = nowIso();
  await withTx(db, (tx) => {
    for (const id of changed) tx.update(s.recipeLinks).set({ position: order.indexOf(id), updatedAt: at }).where(eq(s.recipeLinks.id, id)).run();
    markChanged(tx, LINKS_CLASS, at);
  });
}

const EntrySchema = z.object({
  uid: z.string().min(1),
  part_slug: z.string().nullable(),
  step_no: z.number().int().nullable(),
  kind: z.enum(LINK_KINDS),
  url: z.string().min(1),
  title: z.string().min(1),
  source: z.string().nullable(),
  start_sec: z.number().int().nullable(),
  position: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
const FileSchema = z.object({ slug: z.string().min(1), links: z.array(EntrySchema) });

const PREFIX = "links/";

const entryOf = (r: LinkRow) => ({
  uid: r.uid,
  part_slug: r.partSlug,
  step_no: r.stepNo,
  kind: r.kind,
  url: r.url,
  title: r.title,
  source: r.source,
  start_sec: r.startSec,
  position: r.position,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
});

export const linksClass: HumanDataClass = {
  name: LINKS_CLASS,
  prefix: PREFIX,

  /** One file per recipe, links in position order, keyed by uid. Never contains a database id. */
  async exportFiles(db) {
    const rows = await db
      .select({ link: s.recipeLinks, slug: s.recipes.slug })
      .from(s.recipeLinks)
      .innerJoin(s.recipes, eq(s.recipes.id, s.recipeLinks.recipeId));
    const bySlug = new Map<string, LinkRow[]>();
    for (const { link, slug } of rows) bySlug.set(slug, [...(bySlug.get(slug) ?? []), link]);
    const files: Record<string, string> = {};
    for (const [slug, links] of bySlug) {
      const sorted = [...links].sort((a, b) => a.position - b.position || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
      files[`${PREFIX}${slug}.json`] = stableJson({ slug, links: sorted.map(entryOf) });
    }
    return files;
  },

  /** Adds or updates links by uid. Idempotent. Never deletes: a restore only brings links back. */
  async importFiles(db, files, ctx) {
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const f = FileSchema.parse(JSON.parse(text));
      const recipeId = await ctx.resolveRecipeId(f.slug);
      if (recipeId === undefined) { skipped.push(path); continue; }
      for (const e of f.links) {
        const values = {
          recipeId,
          partSlug: e.part_slug,
          stepNo: e.step_no,
          kind: e.kind,
          url: e.url,
          title: e.title,
          source: e.source,
          startSec: e.start_sec,
          position: e.position,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
        };
        const existing = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(eq(s.recipeLinks.uid, e.uid)))[0];
        if (existing) await db.update(s.recipeLinks).set(values).where(eq(s.recipeLinks.id, existing.id));
        else await db.insert(s.recipeLinks).values({ ...values, uid: e.uid });
        imported++;
      }
    }
    return { imported, skipped };
  },

  async hasRecipeData(db, recipeId) {
    const [row] = await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, recipeId)).limit(1);
    return !!row;
  },

  /** A slug rename: moves every link to the new recipe row, after any links it already has. */
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    const moving = await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, fromRecipeId)).orderBy(asc(s.recipeLinks.position), asc(s.recipeLinks.id));
    if (moving.length === 0) return false;
    const [top] = await db.select({ m: max(s.recipeLinks.position) }).from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, toRecipeId));
    const start = top?.m === null || top?.m === undefined ? 0 : Number(top.m) + 1;
    const at = nowIso();
    await withTx(db, (tx) => {
      moving.forEach((row, index) => {
        tx.update(s.recipeLinks).set({ recipeId: toRecipeId, position: start + index, updatedAt: at }).where(eq(s.recipeLinks.id, row.id)).run();
      });
      markChanged(tx, LINKS_CLASS, at);
    });
    return true;
  },
};
