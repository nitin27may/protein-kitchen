import { and, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { foodLabelKeys } from "../photos/keys";
import { processPhoto } from "../photos/process";
import { HouseholdFoodInput, type HouseholdFoodInputData } from "../schemas/food";
import { personKey } from "./routines";
import type { BlobRef, HumanDataClass } from "./registry";
import { markChanged, newUid, nowIso, stableJson } from "./util";

/**
 * A household's master list of packaged foods. This module is the ONLY writer of `household_foods`
 * (tests/food-writers.test.ts enforces it) and nothing under scripts/ may import it. Every write is household scoped:
 * rows are found by uid AND household, and a person from another household is refused. Macros live on the food only
 * as the per-100 g values the person confirmed; log entries store amounts, never macros.
 */
export const HOUSEHOLD_FOODS_CLASS = "food-catalog";
const PREFIX = "household-foods/";

export type FoodErrorCode = "not-found" | "person-not-found" | "duplicate-barcode" | "has-entries" | "archived" | "plan-not-found" | "not-planned" | "invalid";

export class FoodDataError extends Error {
  override name = "FoodDataError";
  constructor(readonly code: FoodErrorCode, message: string) { super(message); }
}

/** The household every call is confined to, and the person acting (stamped as creator and confirmer). */
export interface FoodScope {
  householdId: string;
  personId: number | null;
}

type FoodRow = typeof s.householdFoods.$inferSelect;
type Queryable = Db | Tx;

/** True when the error, or anything it wraps, is a Postgres unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** The acting person must belong to the household; a person from another household is refused. */
export async function requireHouseholdPerson(tx: Queryable, householdId: string, personId: number | null): Promise<void> {
  if (personId === null) return;
  const [row] = await tx.select({ id: s.people.id }).from(s.people).where(and(eq(s.people.id, personId), eq(s.people.householdId, householdId)));
  if (!row) throw new FoodDataError("person-not-found", "That profile is not in this household.");
}

const byUid = (householdId: string, uid: string) => and(eq(s.householdFoods.uid, uid), eq(s.householdFoods.householdId, householdId));

async function lockFood(tx: Tx, householdId: string, uid: string): Promise<FoodRow> {
  const [row] = await tx.select().from(s.householdFoods).where(byUid(householdId, uid)).for("update");
  if (!row) throw new FoodDataError("not-found", "That food is not in this household.");
  return row;
}

async function assertBarcodeFree(tx: Tx, householdId: string, barcode: string | null, exceptUid?: string): Promise<void> {
  if (barcode === null) return;
  const [clash] = await tx.select({ uid: s.householdFoods.uid }).from(s.householdFoods)
    .where(and(eq(s.householdFoods.householdId, householdId), eq(s.householdFoods.barcode, barcode), exceptUid ? ne(s.householdFoods.uid, exceptUid) : undefined));
  if (clash) throw new FoodDataError("duplicate-barcode", "This household already has a food with that barcode.");
}

function parseInput(input: HouseholdFoodInputData) {
  const parsed = HouseholdFoodInput.safeParse(input);
  if (!parsed.success) throw new FoodDataError("invalid", parsed.error.issues[0]?.message ?? "The food is not valid.");
  return parsed.data;
}

function columns(v: ReturnType<typeof parseInput>) {
  return {
    name: v.name, brand: v.brand, barcode: v.barcode, state: v.state, aisle: v.aisle, kcal: v.kcal, proteinG: v.proteinG, carbsG: v.carbsG,
    fatG: v.fatG, fibreG: v.fibreG, per100gMicros: v.per100gMicros, notReported: [...new Set(v.notReported)].sort(), servingLabel: v.servingLabel,
    servingG: v.servingG, servingMl: v.servingMl, densityGPerMl: v.densityGPerMl, pieceLabel: v.pieceLabel, pieceG: v.pieceG,
    labelBasis: v.labelBasis, labelValues: v.labelValues, source: v.source, sourceId: v.sourceId, fieldOrigins: v.fieldOrigins,
    ingredientsText: v.ingredientsText, isDairy: v.isDairy, containsOnionGarlic: v.containsOnionGarlic, dietFlagsFound: v.dietFlagsFound,
    dietCheckedAt: v.dietCheckedAt,
  };
}

/** Adds a confirmed food to the master list. The person confirming it is stamped with the time. */
export async function createHouseholdFood(db: Db, scope: FoodScope, input: HouseholdFoodInputData): Promise<{ id: number; uid: string }> {
  const v = parseInput(input);
  const at = nowIso();
  const uid = newUid();
  try {
    return await withTx(db, async (tx) => {
      await requireHouseholdPerson(tx, scope.householdId, scope.personId);
      await assertBarcodeFree(tx, scope.householdId, v.barcode);
      const [row] = await tx.insert(s.householdFoods).values({
        ...columns(v), householdId: scope.householdId, uid, createdAt: at, updatedAt: at, createdByPersonId: scope.personId,
        confirmedAt: at, confirmedByPersonId: scope.personId,
      }).returning({ id: s.householdFoods.id });
      await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, scope.householdId);
      return { id: row!.id, uid };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new FoodDataError("duplicate-barcode", "This household already has a food with that barcode.");
    throw e;
  }
}

/**
 * Replaces the confirmed record of a food (uid, creator, label photo and archive state stay). Past log entries keep
 * pointing at the food, so their computed macros change with it; the number of entries affected is returned so the
 * caller can say so.
 */
export async function updateHouseholdFood(db: Db, scope: FoodScope, uid: string, input: HouseholdFoodInputData): Promise<{ affectedEntries: number }> {
  const v = parseInput(input);
  const at = nowIso();
  try {
    return await withTx(db, async (tx) => {
      await requireHouseholdPerson(tx, scope.householdId, scope.personId);
      const row = await lockFood(tx, scope.householdId, uid);
      await assertBarcodeFree(tx, scope.householdId, v.barcode, uid);
      await tx.update(s.householdFoods).set({ ...columns(v), updatedAt: at, confirmedAt: at, confirmedByPersonId: scope.personId }).where(eq(s.householdFoods.id, row.id));
      await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, scope.householdId);
      const [used] = await tx.select({ n: count() }).from(s.foodLog).where(and(eq(s.foodLog.householdFoodId, row.id), eq(s.foodLog.householdId, scope.householdId)));
      return { affectedEntries: Number(used?.n ?? 0) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new FoodDataError("duplicate-barcode", "This household already has a food with that barcode.");
    throw e;
  }
}

async function setArchived(db: Db, scope: FoodScope, uid: string, archived: boolean): Promise<{ changed: boolean }> {
  return withTx(db, async (tx) => {
    const row = await lockFood(tx, scope.householdId, uid);
    if ((row.archivedAt !== null) === archived) return { changed: false };
    const at = nowIso();
    await tx.update(s.householdFoods).set({ archivedAt: archived ? at : null, updatedAt: at }).where(eq(s.householdFoods.id, row.id));
    await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, scope.householdId);
    return { changed: true };
  });
}

/** Hides a food from pickers and refuses new log entries for it. Past entries are untouched. Idempotent. */
export const archiveHouseholdFood = (db: Db, scope: FoodScope, uid: string) => setArchived(db, scope, uid, true);
/** Brings an archived food back. Idempotent. */
export const restoreHouseholdFood = (db: Db, scope: FoodScope, uid: string) => setArchived(db, scope, uid, false);

async function dropLabel(store: BlobStore, photoUid: string): Promise<string[]> {
  const keys = Object.values(foodLabelKeys(photoUid));
  const results = await Promise.allSettled(keys.map((key) => store.delete(key)));
  return keys.filter((_, i) => results[i]!.status === "rejected");
}

/**
 * Removes a food that no log entry uses. A food with entries is refused ("has-entries"): archive it instead. The label
 * photo is deleted after the commit; keys that could not be deleted are returned (photos:check finds them too).
 */
export async function deleteHouseholdFood(db: Db, store: BlobStore, scope: FoodScope, uid: string): Promise<{ staleKeys: string[] }> {
  const photoUid = await withTx(db, async (tx) => {
    const row = await lockFood(tx, scope.householdId, uid);
    const [used] = await tx.select({ n: count() }).from(s.foodLog).where(and(eq(s.foodLog.householdFoodId, row.id), eq(s.foodLog.householdId, scope.householdId)));
    if (Number(used?.n ?? 0) > 0) throw new FoodDataError("has-entries", "This food is in the food log. Archive it instead of deleting it.");
    await tx.delete(s.householdFoods).where(eq(s.householdFoods.id, row.id));
    await markChanged(tx, HOUSEHOLD_FOODS_CLASS, nowIso(), scope.householdId);
    return row.labelPhotoUid;
  });
  return { staleKeys: photoUid ? await dropLabel(store, photoUid) : [] };
}

/**
 * Stores the photo of a food's label (location data dropped, WebP master and thumbnail under `labels/<photoUid>/`). The
 * image work and blob writes run before the transaction; the new blobs are deleted if it fails, and a replaced photo's
 * blobs are deleted after it commits. Returns the keys that could not be deleted.
 */
export async function attachFoodLabelPhoto(db: Db, store: BlobStore, scope: FoodScope, uid: string, bytes: Uint8Array): Promise<{ labelPhotoUid: string; sha256: string; staleKeys: string[] }> {
  const processed = await processPhoto(bytes);
  const photoUid = newUid();
  const keys = foodLabelKeys(photoUid);
  let previous: string | null;
  try {
    await store.put(keys.master, processed.master, "image/webp");
    await store.put(keys.thumb, processed.thumb, "image/webp");
    previous = await withTx(db, async (tx) => {
      const row = await lockFood(tx, scope.householdId, uid);
      const at = nowIso();
      await tx.update(s.householdFoods).set({ labelPhotoUid: photoUid, labelPhotoSha256: processed.sha256, updatedAt: at }).where(eq(s.householdFoods.id, row.id));
      await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, scope.householdId);
      return row.labelPhotoUid;
    });
  } catch (e) {
    const stale = await dropLabel(store, photoUid);
    if (stale.length) throw new AggregateError([e], "Label photo persistence failed and its storage cleanup also failed. Run photos:check before retrying.");
    throw e;
  }
  return { labelPhotoUid: photoUid, sha256: processed.sha256, staleKeys: previous ? await dropLabel(store, previous) : [] };
}

/**
 * Reset "Everything" and household deletion: removes the household's foods (or every food, for the legacy single-household
 * reset) in the caller's transaction and returns the label photo uids whose blobs the caller deletes after the commit. The
 * food log must be cleared first (it points at the foods).
 */
export async function clearHouseholdFoods(tx: Tx, householdId?: string): Promise<string[]> {
  const gone = await tx.delete(s.householdFoods).where(householdId === undefined ? undefined : eq(s.householdFoods.householdId, householdId))
    .returning({ householdId: s.householdFoods.householdId, labelPhotoUid: s.householdFoods.labelPhotoUid });
  const at = nowIso();
  for (const id of new Set(gone.map((r) => r.householdId))) await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, id);
  return gone.flatMap((r) => (r.labelPhotoUid ? [r.labelPhotoUid] : []));
}

/**
 * Account deletion of a member: the foods they added stay with the household, but their profile no longer appears as the
 * creator or confirmer. Runs in the caller's transaction when given one.
 */
export async function detachPersonFromFoods(db: Db, householdId: string, personId: number): Promise<void> {
  await withTx(db, async (tx) => {
    const at = nowIso();
    const created = await tx.update(s.householdFoods).set({ createdByPersonId: null }).where(and(eq(s.householdFoods.householdId, householdId), eq(s.householdFoods.createdByPersonId, personId))).returning({ id: s.householdFoods.id });
    const confirmed = await tx.update(s.householdFoods).set({ confirmedByPersonId: null }).where(and(eq(s.householdFoods.householdId, householdId), eq(s.householdFoods.confirmedByPersonId, personId))).returning({ id: s.householdFoods.id });
    if (created.length || confirmed.length) await markChanged(tx, HOUSEHOLD_FOODS_CLASS, at, householdId);
  });
}

// ---- Export and import ----

const nullableKey = z.string().regex(/^p-[0-9a-f]{16}$/).nullable();
const FileSchema = z.object({
  uid: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().nullable(),
  barcode: z.string().regex(/^\d{8,14}$/).nullable(),
  state: z.enum(["dry", "cooked", "raw", "ready"]),
  aisle: z.string().min(1),
  per100g: z.object({ kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number(), fibre_g: z.number().nullable() }),
  micros_per100g: z.record(z.string(), z.number()),
  not_reported: z.array(z.string()),
  serving: z.object({ label: z.string().nullable(), g: z.number().nullable(), ml: z.number().nullable(), density_g_per_ml: z.number().nullable(), piece_label: z.string().nullable(), piece_g: z.number().nullable() }),
  label_basis: z.enum(["per_serving", "per_100g", "per_100ml"]),
  label_values: z.record(z.string(), z.unknown()),
  source: z.enum(["LABEL", "OFF", "MANUAL"]),
  source_id: z.string().nullable(),
  field_origins: z.record(z.string(), z.string()),
  confirmed_at: z.string(),
  confirmed_by: nullableKey,
  label_photo: z.object({ uid: z.string(), sha256: z.string().length(64) }).nullable(),
  ingredients_text: z.string().nullable(),
  is_dairy: z.boolean(),
  contains_onion_garlic: z.boolean(),
  diet_flags_found: z.array(z.string()),
  diet_checked_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: nullableKey,
});

const iso = (value: string | null) => value === null ? null : new Date(value).toISOString();

async function personKeys(db: Queryable, householdId?: string): Promise<{ keyOf: Map<number, string>; idOf: Map<string, number> }> {
  const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people).where(householdId === undefined ? undefined : eq(s.people.householdId, householdId));
  return { keyOf: new Map(people.map((p) => [p.id, personKey(p.name, p.birthDate)])), idOf: new Map(people.map((p) => [personKey(p.name, p.birthDate), p.id])) };
}

const scopedFoods = (householdId: string | null | undefined) =>
  householdId === undefined ? undefined : householdId === null ? sql`false` : eq(s.householdFoods.householdId, householdId);

export const householdFoodsClass: HumanDataClass = {
  name: HOUSEHOLD_FOODS_CLASS,
  householdScoped: true,
  prefix: PREFIX,

  /** One file per food, `household-foods/<uid>.json`. No database ids; people appear as person keys. */
  async exportFiles(db, scope) {
    const { keyOf } = await personKeys(db);
    const files: Record<string, string> = {};
    for (const f of await db.select().from(s.householdFoods).where(scopedFoods(scope?.householdId))) {
      files[`${PREFIX}${f.uid}.json`] = stableJson({
        uid: f.uid, name: f.name, brand: f.brand, barcode: f.barcode, state: f.state, aisle: f.aisle,
        per100g: { kcal: f.kcal, protein_g: f.proteinG, carbs_g: f.carbsG, fat_g: f.fatG, fibre_g: f.fibreG },
        micros_per100g: f.per100gMicros, not_reported: [...f.notReported].sort(),
        serving: { label: f.servingLabel, g: f.servingG, ml: f.servingMl, density_g_per_ml: f.densityGPerMl, piece_label: f.pieceLabel, piece_g: f.pieceG },
        label_basis: f.labelBasis, label_values: f.labelValues, source: f.source, source_id: f.sourceId, field_origins: f.fieldOrigins,
        confirmed_at: iso(f.confirmedAt), confirmed_by: f.confirmedByPersonId === null ? null : keyOf.get(f.confirmedByPersonId) ?? null,
        label_photo: f.labelPhotoUid && f.labelPhotoSha256 ? { uid: f.labelPhotoUid, sha256: f.labelPhotoSha256 } : null,
        ingredients_text: f.ingredientsText, is_dairy: f.isDairy, contains_onion_garlic: f.containsOnionGarlic,
        diet_flags_found: f.dietFlagsFound, diet_checked_at: iso(f.dietCheckedAt), archived_at: iso(f.archivedAt),
        created_at: iso(f.createdAt), updated_at: iso(f.updatedAt), created_by: f.createdByPersonId === null ? null : keyOf.get(f.createdByPersonId) ?? null,
      });
    }
    return files;
  },

  /**
   * Adds or updates foods by uid inside `ctx.householdId`. Without a household every file is skipped. A uid that belongs to
   * another household, or a barcode another food of this household already has, is skipped, never overwritten. Never deletes.
   */
  async importFiles(db, files, ctx) {
    const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
    const householdId = ctx.householdId;
    if (householdId === undefined) return { imported: 0, skipped: entries.map(([path]) => path) };
    const { idOf } = await personKeys(db, householdId);
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of entries) {
      const f = FileSchema.parse(JSON.parse(text));
      const [existing] = await db.select({ id: s.householdFoods.id, householdId: s.householdFoods.householdId }).from(s.householdFoods).where(eq(s.householdFoods.uid, f.uid));
      if (existing && existing.householdId !== householdId) { skipped.push(path); continue; }
      if (f.barcode !== null) {
        const [clash] = await db.select({ uid: s.householdFoods.uid }).from(s.householdFoods).where(and(eq(s.householdFoods.householdId, householdId), eq(s.householdFoods.barcode, f.barcode), ne(s.householdFoods.uid, f.uid)));
        if (clash) { skipped.push(path); continue; }
      }
      const values = {
        name: f.name, brand: f.brand, barcode: f.barcode, state: f.state, aisle: f.aisle, kcal: f.per100g.kcal, proteinG: f.per100g.protein_g,
        carbsG: f.per100g.carbs_g, fatG: f.per100g.fat_g, fibreG: f.per100g.fibre_g, per100gMicros: f.micros_per100g, notReported: f.not_reported,
        servingLabel: f.serving.label, servingG: f.serving.g, servingMl: f.serving.ml, densityGPerMl: f.serving.density_g_per_ml,
        pieceLabel: f.serving.piece_label, pieceG: f.serving.piece_g, labelBasis: f.label_basis, labelValues: f.label_values, source: f.source,
        sourceId: f.source_id, fieldOrigins: f.field_origins, confirmedAt: f.confirmed_at, confirmedByPersonId: f.confirmed_by ? idOf.get(f.confirmed_by) ?? null : null,
        labelPhotoUid: f.label_photo?.uid ?? null, labelPhotoSha256: f.label_photo?.sha256 ?? null, ingredientsText: f.ingredients_text,
        isDairy: f.is_dairy, containsOnionGarlic: f.contains_onion_garlic, dietFlagsFound: f.diet_flags_found, dietCheckedAt: f.diet_checked_at,
        archivedAt: f.archived_at, createdAt: f.created_at, updatedAt: f.updated_at, createdByPersonId: f.created_by ? idOf.get(f.created_by) ?? null : null,
      };
      if (existing) await db.update(s.householdFoods).set(values).where(eq(s.householdFoods.id, existing.id));
      else await db.insert(s.householdFoods).values({ ...values, uid: f.uid, householdId });
      imported++;
    }
    return { imported, skipped };
  },

  async blobs(db, scope) {
    const refs: BlobRef[] = [];
    const rows = await db.select({ uid: s.householdFoods.labelPhotoUid, sha256: s.householdFoods.labelPhotoSha256 }).from(s.householdFoods)
      .where(and(scopedFoods(scope?.householdId), sql`${s.householdFoods.labelPhotoUid} is not null`));
    for (const p of rows) {
      const keys = foodLabelKeys(p.uid!);
      refs.push({ key: keys.master, ...(p.sha256 ? { sha256: p.sha256 } : {}) }, { key: keys.thumb });
    }
    return refs;
  },
};
