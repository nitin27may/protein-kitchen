import { and, asc, count, eq, isNull, max, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { householdKey, type UsageMap } from "../foods/catalog";
import { isEstimatedWeight, type FoodSourceKind } from "../foods/form";

/**
 * Household-scoped reads of the master list of foods. Every query filters on the household id, so a uid from another
 * household finds nothing. Rows are returned as plain objects (no database ids) for pages, the catalog and, later, the
 * logging screens.
 */
export interface FoodListItem {
  uid: string;
  /** `hf:<uid>`, the key the catalog and the food log use. */
  key: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** null means the label does not report fibre. */
  fibreG: number | null;
  source: FoodSourceKind;
  /** True when the weight per millilitre is the "1 ml = 1 g" guess. */
  estimatedWeight: boolean;
  servingLabel: string | null;
  servingG: number | null;
  servingMl: number | null;
  densityGPerMl: number | null;
  pieceLabel: string | null;
  pieceG: number | null;
  isDairy: boolean;
  containsOnionGarlic: boolean;
  hasLabelPhoto: boolean;
  archived: boolean;
}

export interface FoodDetail extends FoodListItem {
  state: "dry" | "cooked" | "raw" | "ready";
  labelBasis: "per_serving" | "per_100g" | "per_100ml";
  labelValues: Record<string, unknown>;
  per100gMicros: Record<string, number>;
  notReported: string[];
  fieldOrigins: Record<string, string>;
  ingredientsText: string | null;
  dietFlagsFound: string[];
  dietCheckedAt: string | null;
  confirmedAt: string;
  confirmedByName: string | null;
  createdAt: string;
  updatedAt: string;
  labelPhotoUid: string | null;
  /** Food log entries that use this food. */
  usageCount: number;
}

type Row = typeof s.householdFoods.$inferSelect;

function toListItem(r: Row): FoodListItem {
  return {
    uid: r.uid, key: householdKey(r.uid), name: r.name, brand: r.brand, barcode: r.barcode, kcal: r.kcal, proteinG: r.proteinG, carbsG: r.carbsG,
    fatG: r.fatG, fibreG: r.fibreG, source: r.source, estimatedWeight: isEstimatedWeight(r.fieldOrigins), servingLabel: r.servingLabel,
    servingG: r.servingG, servingMl: r.servingMl, densityGPerMl: r.densityGPerMl, pieceLabel: r.pieceLabel, pieceG: r.pieceG, isDairy: r.isDairy,
    containsOnionGarlic: r.containsOnionGarlic, hasLabelPhoto: r.labelPhotoUid !== null, archived: r.archivedAt !== null,
  };
}

/** The household's foods, by name. Archived foods are left out unless asked for. */
export async function listHouseholdFoods(db: Db, householdId: string, options: { includeArchived?: boolean } = {}): Promise<FoodListItem[]> {
  const rows = await db.select().from(s.householdFoods)
    .where(and(eq(s.householdFoods.householdId, householdId), options.includeArchived ? undefined : isNull(s.householdFoods.archivedAt)))
    .orderBy(asc(sql`lower(${s.householdFoods.name})`), asc(s.householdFoods.id));
  return rows.map(toListItem);
}

/** One food by uid, with the number of log entries that use it. Null when it is not in this household. */
export async function getHouseholdFood(db: Db, householdId: string, uid: string): Promise<FoodDetail | null> {
  const [found] = await db.select({ food: s.householdFoods, confirmer: s.people.name }).from(s.householdFoods)
    .leftJoin(s.people, and(eq(s.people.id, s.householdFoods.confirmedByPersonId), eq(s.people.householdId, s.householdFoods.householdId)))
    .where(and(eq(s.householdFoods.householdId, householdId), eq(s.householdFoods.uid, uid))).limit(1);
  if (!found) return null;
  const row = found.food;
  const [used] = await db.select({ n: count() }).from(s.foodLog).where(and(eq(s.foodLog.householdFoodId, row.id), eq(s.foodLog.householdId, householdId)));
  return {
    ...toListItem(row), state: row.state, labelBasis: row.labelBasis, labelValues: row.labelValues, per100gMicros: row.per100gMicros,
    notReported: row.notReported, fieldOrigins: row.fieldOrigins, ingredientsText: row.ingredientsText, dietFlagsFound: row.dietFlagsFound,
    dietCheckedAt: row.dietCheckedAt, confirmedAt: row.confirmedAt, confirmedByName: found.confirmer, createdAt: row.createdAt, updatedAt: row.updatedAt,
    labelPhotoUid: row.labelPhotoUid, usageCount: Number(used!.n),
  };
}

/** How often and how recently each household food was logged, keyed `hf:<uid>`, for ranking search results. */
export async function householdFoodUsage(db: Db, householdId: string): Promise<UsageMap> {
  const rows = await db.select({ uid: s.householdFoods.uid, n: count(s.foodLog.id), last: max(s.foodLog.createdAt) })
    .from(s.foodLog).innerJoin(s.householdFoods, and(eq(s.householdFoods.id, s.foodLog.householdFoodId), eq(s.householdFoods.householdId, s.foodLog.householdId)))
    .where(eq(s.foodLog.householdId, householdId)).groupBy(s.householdFoods.uid);
  return Object.fromEntries(rows.map((r) => [householdKey(r.uid), { count: Number(r.n), lastLoggedAt: new Date(r.last!).toISOString() }]));
}
