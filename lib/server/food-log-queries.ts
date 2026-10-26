import { and, count, eq, gte, inArray, isNull, lte, max, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { Tx } from "../db/tx";
import { requireMember } from "../auth/access";
import { memberHouseholdAccess, type HouseholdAccess } from "../auth/household-access";
import type { UsageMap } from "../foods/catalog";
import { householdKey } from "../foods/catalog";
import type { FoodLogRowLike, PlanSlotInput } from "../food-log/keys";
import type { HouseholdFoodNutrition } from "../food-log/lookups";
import { RECIPE_PREFIX } from "../food-log/preview";
import { getDb } from "./context";

/**
 * Household-scoped reads for the food log. Every function takes the household id and filters on it; none reads across
 * households. The request wrappers at the bottom resolve the signed-in household and, for a member, narrow people to
 * the member's own profile (an owner reads everyone in the household).
 *
 * Household foods: F3a owns the foods read in lib/server/food-queries.ts. Until it is on main this module has its own
 * small private read (`readHouseholdFoods`); switch to F3a's read once it exists.
 */
type Queryable = Db | Tx;

export async function readFoodEntries(db: Queryable, householdId: string, filter: { personIds: readonly number[]; from: string; to: string }): Promise<FoodLogRowLike[]> {
  if (filter.personIds.length === 0) return [];
  const rows = await db.select({ row: s.foodLog, foodUid: s.householdFoods.uid }).from(s.foodLog)
    .leftJoin(s.householdFoods, and(eq(s.householdFoods.id, s.foodLog.householdFoodId), eq(s.householdFoods.householdId, s.foodLog.householdId)))
    .where(and(
      eq(s.foodLog.householdId, householdId), inArray(s.foodLog.personId, [...filter.personIds]),
      gte(s.foodLog.date, filter.from), lte(s.foodLog.date, filter.to),
    )).orderBy(s.foodLog.date, s.foodLog.createdAt, s.foodLog.id);
  return rows.map(({ row, foodUid }) => ({
    uid: row.uid, personId: row.personId, date: row.date, slot: row.slot, kind: row.kind, recipeSlug: row.recipeSlug, servings: row.servings,
    ingredientSlug: row.ingredientSlug, householdFoodUid: foodUid, grams: row.grams, displayQty: row.displayQty, displayUnit: row.displayUnit,
    planId: row.planId, plannedRecipeSlug: row.plannedRecipeSlug, plannedServings: row.plannedServings, note: row.note,
  }));
}

/** One entry of this household, or undefined. */
export async function readFoodEntry(db: Queryable, householdId: string, uid: string): Promise<FoodLogRowLike | undefined> {
  const [row] = await db.select({ id: s.foodLog.id, date: s.foodLog.date, personId: s.foodLog.personId }).from(s.foodLog)
    .where(and(eq(s.foodLog.uid, uid), eq(s.foodLog.householdId, householdId)));
  if (!row) return undefined;
  return (await readFoodEntries(db, householdId, { personIds: [row.personId], from: row.date, to: row.date })).find((e) => e.uid === uid);
}

/** How often and how lately each food was logged, for recents. Skipped meals are not use. Keyed like the catalog. */
export async function readFoodUsage(db: Queryable, householdId: string): Promise<UsageMap> {
  const rows = await db.select({
    ingredient: s.foodLog.ingredientSlug, recipe: s.foodLog.recipeSlug, food: s.householdFoods.uid, n: count(), last: max(s.foodLog.createdAt),
  }).from(s.foodLog)
    .leftJoin(s.householdFoods, and(eq(s.householdFoods.id, s.foodLog.householdFoodId), eq(s.householdFoods.householdId, s.foodLog.householdId)))
    .where(and(eq(s.foodLog.householdId, householdId), ne(s.foodLog.kind, "skipped")))
    .groupBy(s.foodLog.ingredientSlug, s.foodLog.recipeSlug, s.householdFoods.uid);
  const usage: Record<string, { count: number; lastLoggedAt?: string }> = {};
  for (const r of rows) {
    const key = r.food !== null ? householdKey(r.food) : r.ingredient !== null ? r.ingredient : r.recipe !== null ? `${RECIPE_PREFIX}${r.recipe}` : null;
    if (key === null) continue;
    usage[key] = { count: Number(r.n), ...(r.last ? { lastLoggedAt: r.last } : {}) };
  }
  return usage;
}

export interface HouseholdFoodRow extends HouseholdFoodNutrition {
  name: string;
  brand: string | null;
  barcode: string | null;
  aisle: string;
  state: string;
  servingG: number | null;
  servingMl: number | null;
  servingLabel: string | null;
  pieceG: number | null;
  pieceLabel: string | null;
  densityGPerMl: number | null;
  archived: boolean;
}

/** The household's foods. Archived foods stay in nutrition lookups (old entries keep counting) but not in the catalog. */
export async function readHouseholdFoods(db: Queryable, householdId: string, options: { includeArchived: boolean }): Promise<HouseholdFoodRow[]> {
  const rows = await db.select().from(s.householdFoods)
    .where(and(eq(s.householdFoods.householdId, householdId), options.includeArchived ? undefined : isNull(s.householdFoods.archivedAt)))
    .orderBy(s.householdFoods.name, s.householdFoods.id);
  return rows.map((f) => ({
    uid: f.uid, kcal: f.kcal, proteinG: f.proteinG, carbsG: f.carbsG, fatG: f.fatG, fibreG: f.fibreG, name: f.name, brand: f.brand, barcode: f.barcode,
    aisle: f.aisle, state: f.state, servingG: f.servingG, servingMl: f.servingMl, servingLabel: f.servingLabel, pieceG: f.pieceG, pieceLabel: f.pieceLabel,
    densityGPerMl: f.densityGPerMl, archived: f.archivedAt !== null,
  }));
}

export interface PlanSlotRow extends PlanSlotInput {
  planId: number;
  locked: boolean;
}

/** Slots of one plan (optionally one date) of this household, with each person's portion. */
export async function readPlanSlots(db: Queryable, householdId: string, planId: number, date?: string): Promise<PlanSlotRow[]> {
  const slots = await db.select({ id: s.planSlots.id, planId: s.planSlots.planId, date: s.planSlots.date, slot: s.planSlots.slot, locked: s.planSlots.locked, recipe: s.recipes.slug })
    .from(s.planSlots).innerJoin(s.plans, eq(s.plans.id, s.planSlots.planId)).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId))
    .where(and(eq(s.plans.householdId, householdId), eq(s.planSlots.planId, planId), date === undefined ? undefined : eq(s.planSlots.date, date)))
    .orderBy(s.planSlots.date, s.planSlots.id);
  if (slots.length === 0) return [];
  const portions = await db.select().from(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slots.map((x) => x.id)));
  return slots.map((x) => ({
    id: x.id, planId: x.planId, date: x.date, slot: x.slot, recipeSlug: x.recipe, locked: x.locked,
    servings: Object.fromEntries(portions.filter((p) => p.planSlotId === x.id).map((p) => [String(p.personId), p.servings])),
  }));
}

/** One plan slot of this household by id. */
export async function readPlanSlot(db: Queryable, householdId: string, planSlotId: number): Promise<PlanSlotRow | undefined> {
  const [found] = await db.select({ planId: s.planSlots.planId }).from(s.planSlots).innerJoin(s.plans, eq(s.plans.id, s.planSlots.planId))
    .where(and(eq(s.planSlots.id, planSlotId), eq(s.plans.householdId, householdId)));
  return found ? (await readPlanSlots(db, householdId, found.planId)).find((x) => x.id === planSlotId) : undefined;
}

// ---- Request wrappers ----

export interface LogReadScope {
  db: Db;
  access: HouseholdAccess;
}

async function readScope(): Promise<LogReadScope> {
  const db = await getDb();
  return { db, access: await memberHouseholdAccess(db, await requireMember()) };
}

/** People whose log the signed-in member may read: everyone for an owner, only themselves for a member. */
export function readablePersonIds(access: Pick<HouseholdAccess, "role" | "personId">, personIds: readonly number[]): number[] {
  return access.role === "owner" ? [...personIds] : personIds.filter((id) => id === access.personId);
}

export async function getFoodEntries(personIds: readonly number[], from: string, to: string): Promise<FoodLogRowLike[]> {
  const { db, access } = await readScope();
  return readFoodEntries(db, access.householdId, { personIds: readablePersonIds(access, personIds), from, to });
}

export async function getFoodUsage(): Promise<UsageMap> {
  const { db, access } = await readScope();
  return readFoodUsage(db, access.householdId);
}

export async function getHouseholdFoodRows(includeArchived: boolean): Promise<HouseholdFoodRow[]> {
  const { db, access } = await readScope();
  return readHouseholdFoods(db, access.householdId, { includeArchived });
}

/** One household food by uid, archived or not. */
export async function readHouseholdFood(db: Queryable, householdId: string, uid: string): Promise<HouseholdFoodRow | undefined> {
  const [row] = await db.select().from(s.householdFoods).where(and(eq(s.householdFoods.uid, uid), eq(s.householdFoods.householdId, householdId)));
  if (!row) return undefined;
  return (await readHouseholdFoods(db, householdId, { includeArchived: true })).find((f) => f.uid === uid);
}
