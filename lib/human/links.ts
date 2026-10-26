import { and, asc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx, type Tx } from "../db/tx";
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
const owned = (householdId?: string) => householdId === undefined ? isNull(s.recipeLinks.householdId) : eq(s.recipeLinks.householdId, householdId);

/** Adds a link at the end of the recipe's list. The only writer of new links. */
export async function writeLink(db: Db, recipeId: number, input: LinkRowInput, personId?: number | null, householdId?: string): Promise<{ id: number; uid: string }> {
  const at = nowIso();
  const uid = newUid();
  const [top] = await db.select({ m: max(s.recipeLinks.position) }).from(s.recipeLinks).where(and(eq(s.recipeLinks.recipeId, recipeId), owned(householdId)));
  const position = top?.m === null || top?.m === undefined ? 0 : Number(top.m) + 1;
  const id = await withTx(db, async (tx) => {
    const row = (await tx
      .insert(s.recipeLinks)
      .values({
        uid,
        householdId: householdId ?? null,
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
      .returning({ id: s.recipeLinks.id }))[0];
    await markChanged(tx, LINKS_CLASS, at, householdId);
    return row!.id;
  });
  return { id, uid };
}

/** Legacy household import writer: keeps the bundle's uid, position and timestamps; does not mark the class changed. */
export async function insertLegacyLinks(tx: Tx, householdId: string, rows: readonly (LinkRowInput & {
  recipeId: number; uid: string; position: number; createdAt: string; updatedAt: string; createdByPersonId: number | null;
})[]): Promise<void> {
  if (!rows.length) return;
  await tx.insert(s.recipeLinks).values(rows.map((row) => ({
    householdId, recipeId: row.recipeId, uid: row.uid, partSlug: row.partSlug ?? null, stepNo: row.stepNo ?? null, kind: row.kind, url: row.url,
    title: row.title, source: row.source ?? null, startSec: row.startSec ?? null, position: row.position,
    createdAt: row.createdAt, updatedAt: row.updatedAt, createdByPersonId: row.createdByPersonId,
  })));
}

/** Changes the fields in `patch`; the uid, position and created_at stay. Returns false if the link does not exist. */
export async function updateLinkRow(db: Db, id: number, patch: Partial<LinkRowInput>, householdId?: string): Promise<boolean> {
  const predicate = and(eq(s.recipeLinks.id, id), owned(householdId));
  const existing = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(predicate))[0];
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
  await withTx(db, async (tx) => {
    await tx.update(s.recipeLinks).set(set).where(predicate);
    await markChanged(tx, LINKS_CLASS, at, householdId);
  });
  return true;
}

export async function deleteLinkRow(db: Db, id: number, householdId?: string): Promise<boolean> {
  const predicate = and(eq(s.recipeLinks.id, id), owned(householdId));
  const existing = (await db.select({ id: s.recipeLinks.id }).from(s.recipeLinks).where(predicate))[0];
  if (!existing) return false;
  const at = nowIso();
  await withTx(db, async (tx) => {
    await tx.delete(s.recipeLinks).where(predicate);
    await markChanged(tx, LINKS_CLASS, at, householdId);
  });
  return true;
}

/**
 * Puts the recipe's links in the given order. Ids that do not belong to the recipe are ignored; links not named keep
 * their relative order after the named ones. Positions are rewritten as 0, 1, 2, and only rows that moved change.
 */
export async function reorderLinks(db: Db, recipeId: number, orderedIds: number[], householdId?: string): Promise<void> {
  const rows = await db.select().from(s.recipeLinks).where(and(eq(s.recipeLinks.recipeId, recipeId), owned(householdId))).orderBy(asc(s.recipeLinks.position), asc(s.recipeLinks.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const named = [...new Set(orderedIds)].filter((id) => byId.has(id));
  const rest = rows.filter((r) => !named.includes(r.id)).map((r) => r.id);
  const order = [...named, ...rest];
  const changed = order.filter((id, index) => byId.get(id)!.position !== index);
  if (changed.length === 0) return;
  const at = nowIso();
  await withTx(db, async (tx) => {
    for (const id of changed) await tx.update(s.recipeLinks).set({ position: order.indexOf(id), updatedAt: at }).where(and(eq(s.recipeLinks.id, id), owned(householdId)));
    await markChanged(tx, LINKS_CLASS, at, householdId);
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
  householdScoped: true,
  prefix: PREFIX,

  /** One file per recipe, links in position order, keyed by uid. Never contains a database id. */
  async exportFiles(db, scope) {
    const rows = await db
      .select({ link: s.recipeLinks, slug: s.recipes.slug })
      .from(s.recipeLinks)
      .innerJoin(s.recipes, eq(s.recipes.id, s.recipeLinks.recipeId))
      .where(scope ? owned(scope.householdId ?? undefined) : undefined);
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
    return withTx(db, async (tx) => {
      const moving = await tx.select({ id: s.recipeLinks.id, householdId: s.recipeLinks.householdId }).from(s.recipeLinks).where(eq(s.recipeLinks.recipeId, fromRecipeId)).orderBy(asc(s.recipeLinks.position), asc(s.recipeLinks.id));
      for (const householdId of new Set(moving.map((row) => row.householdId))) {
        const rows = moving.filter((row) => row.householdId === householdId);
        const [top] = await tx.select({ m: max(s.recipeLinks.position) }).from(s.recipeLinks).where(and(eq(s.recipeLinks.recipeId, toRecipeId), owned(householdId ?? undefined)));
        const start = top?.m === null || top?.m === undefined ? 0 : Number(top.m) + 1;
        const at = nowIso();
        for (const [index, row] of rows.entries()) {
          await tx.update(s.recipeLinks).set({ recipeId: toRecipeId, position: start + index, updatedAt: at }).where(eq(s.recipeLinks.id, row.id));
        }
        await markChanged(tx, LINKS_CLASS, at, householdId ?? undefined);
      }
      return moving.length > 0;
    });
  },
};
