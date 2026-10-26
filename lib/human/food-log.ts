import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { FoodLogEntryInput, FoodLogEntryUpdate, FOOD_LOG_KINDS, FOOD_LOG_SLOTS, type FoodLogEntryData, type FoodLogEntryInputData, type FoodLogEntryUpdateData } from "../schemas/food";
import { FoodDataError, requireHouseholdPerson, type FoodScope } from "./household-foods";
import type { HumanDataClass } from "./registry";
import { personKey } from "./routines";
import { markChanged, newUid, nowIso, stableJson } from "./util";

/**
 * What each person ate. This module is the ONLY writer of `food_log` (tests/food-writers.test.ts enforces it) and
 * nothing under scripts/ may import it. Entries store amounts only; macros are computed from the recipe, ingredient or
 * household food when they are read. Every lookup is by uid AND household, and an item from another household is refused.
 *
 * A `skipped` entry names the skipped meal in its item columns and is never counted as eaten by readers.
 */
export const FOOD_LOG_CLASS = "food-log";
const PREFIX = "food-log/";

type Queryable = Db | Tx;
type EntryRow = typeof s.foodLog.$inferSelect;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new FoodDataError("invalid", parsed.error.issues[0]?.message ?? "The entry is not valid.");
  return parsed.data;
}

/** Resolves the item to the columns that hold it. A household food is found by uid in this household, and must not be archived. */
async function itemColumns(tx: Tx, householdId: string, item: FoodLogEntryData["item"]) {
  const empty = { recipeSlug: null, servings: null, ingredientSlug: null, householdFoodId: null, grams: null } as {
    recipeSlug: string | null; servings: number | null; ingredientSlug: string | null; householdFoodId: number | null; grams: number | null;
  };
  switch (item.type) {
    case "recipe": return { ...empty, recipeSlug: item.recipeSlug, servings: item.servings };
    case "ingredient": return { ...empty, ingredientSlug: item.ingredientSlug, grams: item.grams };
    case "food": {
      const [food] = await tx.select({ id: s.householdFoods.id, archivedAt: s.householdFoods.archivedAt }).from(s.householdFoods)
        .where(and(eq(s.householdFoods.uid, item.householdFoodUid), eq(s.householdFoods.householdId, householdId))).for("share");
      if (!food) throw new FoodDataError("not-found", "That food is not in this household.");
      if (food.archivedAt !== null) throw new FoodDataError("archived", "That food is archived. Restore it before logging it.");
      return { ...empty, householdFoodId: food.id, grams: item.grams };
    }
  }
}

async function requirePlan(tx: Tx, householdId: string, planId: number | null): Promise<void> {
  if (planId === null) return;
  const [plan] = await tx.select({ id: s.plans.id }).from(s.plans).where(and(eq(s.plans.id, planId), eq(s.plans.householdId, householdId)));
  if (!plan) throw new FoodDataError("plan-not-found", "That plan is not in this household.");
}

function common(v: Omit<FoodLogEntryData, "personId" | "item">) {
  return {
    date: v.date, slot: v.slot, kind: v.kind, displayQty: v.displayQty, displayUnit: v.displayUnit, planId: v.planId,
    plannedRecipeSlug: v.plannedRecipeSlug, plannedServings: v.plannedServings, note: v.note,
  };
}

/** Records what a person ate (or skipped, swapped or added). The person and the item must belong to the household. */
export async function logFoodEntry(db: Db, scope: FoodScope, input: FoodLogEntryInputData): Promise<{ id: number; uid: string }> {
  const v = parse(FoodLogEntryInput, input);
  const at = nowIso();
  const uid = newUid();
  return withTx(db, async (tx) => {
    await requireHouseholdPerson(tx, scope.householdId, scope.personId);
    const [person] = await tx.select({ id: s.people.id }).from(s.people).where(and(eq(s.people.id, v.personId), eq(s.people.householdId, scope.householdId)));
    if (!person) throw new FoodDataError("person-not-found", "That profile is not in this household.");
    await requirePlan(tx, scope.householdId, v.planId);
    const item = await itemColumns(tx, scope.householdId, v.item);
    const [row] = await tx.insert(s.foodLog).values({
      ...common(v), ...item, uid, householdId: scope.householdId, personId: v.personId, createdAt: at, updatedAt: at, createdByPersonId: scope.personId,
    }).returning({ id: s.foodLog.id });
    await markChanged(tx, FOOD_LOG_CLASS, at, scope.householdId);
    return { id: row!.id, uid };
  });
}

/** Replaces the editable fields of an entry. The person, uid and created_at stay. */
export async function updateFoodEntry(db: Db, scope: FoodScope, uid: string, input: z.input<typeof FoodLogEntryUpdate>): Promise<void> {
  const v = parse<FoodLogEntryUpdateData>(FoodLogEntryUpdate, input);
  const at = nowIso();
  await withTx(db, async (tx) => {
    const [row] = await tx.select({ id: s.foodLog.id }).from(s.foodLog).where(and(eq(s.foodLog.uid, uid), eq(s.foodLog.householdId, scope.householdId))).for("update");
    if (!row) throw new FoodDataError("not-found", "That entry is not in this household.");
    await requirePlan(tx, scope.householdId, v.planId);
    const item = await itemColumns(tx, scope.householdId, v.item);
    await tx.update(s.foodLog).set({ ...common(v), ...item, updatedAt: at }).where(eq(s.foodLog.id, row.id));
    await markChanged(tx, FOOD_LOG_CLASS, at, scope.householdId);
  });
}

/** Removes one entry. Returns false when the household has no such entry. */
export async function deleteFoodEntry(db: Db, scope: FoodScope, uid: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const gone = await tx.delete(s.foodLog).where(and(eq(s.foodLog.uid, uid), eq(s.foodLog.householdId, scope.householdId))).returning({ id: s.foodLog.id });
    if (!gone.length) return false;
    await markChanged(tx, FOOD_LOG_CLASS, nowIso(), scope.householdId);
    return true;
  });
}

export interface PlannedMealEaten {
  planSlotId: number;
  personId: number;
  /** Servings actually eaten; defaults to the person's planned portion. */
  servings?: number;
  note?: string | null;
}

/**
 * "I ate what was planned". Copies the recipe, servings and plan from the plan slot into a `planned` entry and locks the
 * slot in the same transaction, so regenerating the plan keeps the meal that was eaten. Asking twice for the same
 * person and slot returns the first entry.
 */
export async function markPlannedMealEaten(db: Db, scope: FoodScope, input: PlannedMealEaten): Promise<{ id: number; uid: string; created: boolean }> {
  const at = nowIso();
  return withTx(db, async (tx) => {
    await requireHouseholdPerson(tx, scope.householdId, scope.personId);
    const [person] = await tx.select({ id: s.people.id }).from(s.people).where(and(eq(s.people.id, input.personId), eq(s.people.householdId, scope.householdId)));
    if (!person) throw new FoodDataError("person-not-found", "That profile is not in this household.");
    const [slot] = await tx.select({ id: s.planSlots.id, planId: s.planSlots.planId, date: s.planSlots.date, slot: s.planSlots.slot, recipe: s.recipes.slug })
      .from(s.planSlots).innerJoin(s.plans, eq(s.plans.id, s.planSlots.planId)).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId))
      .where(and(eq(s.planSlots.id, input.planSlotId), eq(s.plans.householdId, scope.householdId))).for("update");
    if (!slot) throw new FoodDataError("plan-not-found", "That planned meal is not in this household.");
    const [portion] = await tx.select({ servings: s.planSlotPortions.servings }).from(s.planSlotPortions)
      .where(and(eq(s.planSlotPortions.planSlotId, slot.id), eq(s.planSlotPortions.personId, input.personId)));
    if (!portion && input.servings === undefined) throw new FoodDataError("not-planned", "That meal is not planned for this person.");
    const planned = portion?.servings ?? input.servings!;
    const servings = input.servings ?? planned;
    if (!(servings > 0) || !(planned > 0)) throw new FoodDataError("invalid", "Servings must be more than zero.");

    // No plan writer module exists yet (toggleLock in app/actions.ts is an inline update), so this is a minimal guarded
    // update: the slot is already proven to belong to this household's plan above.
    await tx.update(s.planSlots).set({ locked: true }).where(eq(s.planSlots.id, slot.id));

    const [existing] = await tx.select({ id: s.foodLog.id, uid: s.foodLog.uid }).from(s.foodLog).where(and(
      eq(s.foodLog.householdId, scope.householdId), eq(s.foodLog.personId, input.personId), eq(s.foodLog.planId, slot.planId),
      eq(s.foodLog.date, slot.date), eq(s.foodLog.slot, slot.slot), eq(s.foodLog.kind, "planned"), eq(s.foodLog.recipeSlug, slot.recipe)));
    if (existing) return { id: existing.id, uid: existing.uid, created: false };

    const uid = newUid();
    const [row] = await tx.insert(s.foodLog).values({
      uid, householdId: scope.householdId, personId: input.personId, date: slot.date, slot: slot.slot, kind: "planned",
      recipeSlug: slot.recipe, servings, planId: slot.planId, plannedRecipeSlug: slot.recipe, plannedServings: planned,
      note: input.note?.trim() || null, createdAt: at, updatedAt: at, createdByPersonId: scope.personId,
    }).returning({ id: s.foodLog.id });
    await markChanged(tx, FOOD_LOG_CLASS, at, scope.householdId);
    return { id: row!.id, uid, created: true };
  });
}

/** Member account deletion: removes everything the person logged. Returns how many entries went. */
export async function deleteFoodLogForPerson(db: Db, personId: number): Promise<number> {
  return withTx(db, async (tx) => {
    const gone = await tx.delete(s.foodLog).where(eq(s.foodLog.personId, personId)).returning({ householdId: s.foodLog.householdId });
    const at = nowIso();
    for (const householdId of new Set(gone.map((r) => r.householdId))) await markChanged(tx, FOOD_LOG_CLASS, at, householdId);
    return gone.length;
  });
}

/**
 * Reset and household deletion. Deletes entries of the given profiles, or of the whole household, or (no scope, the legacy
 * single-household reset) of everyone, and marks the class changed for each household touched. Runs in the caller's
 * transaction. Entries go before foods and people because they point at both.
 */
export async function clearFoodLog(tx: Tx, scope: { householdId?: string; personIds?: readonly number[] } = {}): Promise<number> {
  if (scope.personIds && !scope.personIds.length) return 0;
  const gone = await tx.delete(s.foodLog).where(and(
    scope.householdId === undefined ? undefined : eq(s.foodLog.householdId, scope.householdId),
    scope.personIds ? inArray(s.foodLog.personId, [...scope.personIds]) : undefined,
  )).returning({ householdId: s.foodLog.householdId });
  const at = nowIso();
  for (const householdId of new Set(gone.map((r) => r.householdId))) await markChanged(tx, FOOD_LOG_CLASS, at, householdId);
  return gone.length;
}

/**
 * Entries name library recipes and ingredients by slug. Recipe slugs follow data/renames.json (the rename hooks below), but
 * ingredient slugs have no rename map, so a renamed or removed ingredient would leave a dangling slug. This reports them.
 */
export async function findDanglingFoodLogSlugs(db: Queryable, householdId?: string): Promise<{ ingredients: string[]; recipes: string[] }> {
  const owned = householdId === undefined ? undefined : eq(s.foodLog.householdId, householdId);
  const ingredientSlugs = (await db.selectDistinct({ slug: s.foodLog.ingredientSlug }).from(s.foodLog).where(and(owned, isNotNull(s.foodLog.ingredientSlug)))).map((r) => r.slug!);
  const known = new Set((ingredientSlugs.length ? await db.select({ slug: s.ingredients.slug }).from(s.ingredients).where(inArray(s.ingredients.slug, ingredientSlugs)) : []).map((r) => r.slug));
  const recipeRows = await db.execute(sql`select distinct slug from (
      select recipe_slug as slug from food_log where recipe_slug is not null ${householdId === undefined ? sql`` : sql`and household_id = ${householdId}`}
      union select planned_recipe_slug from food_log where planned_recipe_slug is not null ${householdId === undefined ? sql`` : sql`and household_id = ${householdId}`}
    ) used where slug not in (select slug from recipes) order by slug`);
  return {
    ingredients: ingredientSlugs.filter((slug) => !known.has(slug)).sort(),
    recipes: (recipeRows as unknown as { rows: { slug: string }[] }).rows.map((r) => r.slug),
  };
}

// ---- Rename hooks ----

async function rewriteRecipeSlug(db: Db, oldSlug: string, newSlug: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const at = nowIso();
    const households = new Set<string>();
    for (const column of ["recipeSlug", "plannedRecipeSlug"] as const) {
      const rows = await tx.update(s.foodLog).set({ [column]: newSlug, updatedAt: at }).where(eq(s.foodLog[column], oldSlug)).returning({ householdId: s.foodLog.householdId });
      for (const r of rows) households.add(r.householdId);
    }
    for (const householdId of households) await markChanged(tx, FOOD_LOG_CLASS, at, householdId);
    return households.size > 0;
  });
}

// ---- Export and import ----

const EntrySchema = z.object({
  uid: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.enum(FOOD_LOG_SLOTS),
  kind: z.enum(FOOD_LOG_KINDS),
  item: z.discriminatedUnion("type", [
    z.object({ type: z.literal("recipe"), recipe: z.string().min(1), servings: z.number().positive() }),
    z.object({ type: z.literal("ingredient"), ingredient: z.string().min(1), grams: z.number().positive() }),
    z.object({ type: z.literal("food"), food: z.string().min(1), grams: z.number().positive() }),
  ]),
  display_qty: z.number().nullable(),
  display_unit: z.string().nullable(),
  planned_recipe: z.string().nullable(),
  planned_servings: z.number().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const FileSchema = z.object({ person: z.string().regex(/^p-[0-9a-f]{16}$/), month: z.string().regex(/^\d{4}-\d{2}$/), entries: z.array(EntrySchema) });

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export const foodLogClass: HumanDataClass = {
  name: FOOD_LOG_CLASS,
  householdScoped: true,
  prefix: PREFIX,

  /**
   * One file per person and month, `food-log/<personKey>/<yyyy-mm>.json`. Entries are keyed by uid, household foods by
   * uid and library items by slug. The plan link is a database id and is not exported (a restore has no matching plan).
   */
  async exportFiles(db, scope) {
    if (scope && scope.householdId === null) return {};
    const where = scope ? eq(s.foodLog.householdId, scope.householdId!) : undefined;
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people);
    const keyOf = new Map(people.map((p) => [p.id, personKey(p.name, p.birthDate)]));
    const rows = await db.select({ e: s.foodLog, food: s.householdFoods.uid }).from(s.foodLog)
      .leftJoin(s.householdFoods, and(eq(s.householdFoods.id, s.foodLog.householdFoodId), eq(s.householdFoods.householdId, s.foodLog.householdId))).where(where);
    const groups = new Map<string, { person: string; month: string; rows: { e: EntryRow; food: string | null }[] }>();
    for (const row of rows) {
      const person = keyOf.get(row.e.personId);
      if (!person) continue;
      const month = row.e.date.slice(0, 7);
      const key = `${person}/${month}`;
      const group = groups.get(key) ?? { person, month, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    const files: Record<string, string> = {};
    for (const [key, group] of groups) {
      const entries = [...group.rows].sort((a, b) => compare(a.e.date, b.e.date) || compare(a.e.slot, b.e.slot) || compare(a.e.uid, b.e.uid)).map(({ e, food }) => ({
        uid: e.uid, date: e.date, slot: e.slot, kind: e.kind,
        item: e.recipeSlug !== null ? { type: "recipe", recipe: e.recipeSlug, servings: e.servings }
          : e.ingredientSlug !== null ? { type: "ingredient", ingredient: e.ingredientSlug, grams: e.grams }
          : { type: "food", food: food!, grams: e.grams },
        display_qty: e.displayQty, display_unit: e.displayUnit, planned_recipe: e.plannedRecipeSlug, planned_servings: e.plannedServings,
        note: e.note, created_at: new Date(e.createdAt).toISOString(), updated_at: new Date(e.updatedAt).toISOString(),
      }));
      files[`${PREFIX}${key}.json`] = stableJson({ person: group.person, month: group.month, entries });
    }
    return files;
  },

  /**
   * Adds or updates entries by uid inside `ctx.householdId`. Skips a file when there is no household or no person with
   * that key, and an entry whose household food is missing. A uid owned by another household is never overwritten.
   * Classes load in name order, so `food-catalog` (the foods) comes before `food-log`.
   */
  async importFiles(db, files, ctx) {
    const paths = Object.entries(files).sort(([a], [b]) => compare(a, b));
    const householdId = ctx.householdId;
    if (householdId === undefined) return { imported: 0, skipped: paths.map(([path]) => path) };
    const people = await db.select({ id: s.people.id, name: s.people.name, birthDate: s.people.birthDate }).from(s.people).where(eq(s.people.householdId, householdId));
    const personByKey = new Map(people.map((p) => [personKey(p.name, p.birthDate), p.id]));
    const foods = await db.select({ id: s.householdFoods.id, uid: s.householdFoods.uid }).from(s.householdFoods).where(eq(s.householdFoods.householdId, householdId));
    const foodByUid = new Map(foods.map((f) => [f.uid, f.id]));
    let imported = 0;
    const skipped: string[] = [];
    for (const [path, text] of paths) {
      const f = FileSchema.parse(JSON.parse(text));
      const personId = personByKey.get(f.person);
      if (personId === undefined) { skipped.push(path); continue; }
      for (const e of f.entries) {
        const foodId = e.item.type === "food" ? foodByUid.get(e.item.food) : undefined;
        if (e.item.type === "food" && foodId === undefined) { skipped.push(`${path}#${e.uid}`); continue; }
        const [existing] = await db.select({ id: s.foodLog.id, householdId: s.foodLog.householdId }).from(s.foodLog).where(eq(s.foodLog.uid, e.uid));
        if (existing && existing.householdId !== householdId) { skipped.push(`${path}#${e.uid}`); continue; }
        const values = {
          personId, date: e.date, slot: e.slot, kind: e.kind,
          recipeSlug: e.item.type === "recipe" ? e.item.recipe : null, servings: e.item.type === "recipe" ? e.item.servings : null,
          ingredientSlug: e.item.type === "ingredient" ? e.item.ingredient : null, householdFoodId: foodId ?? null,
          grams: e.item.type === "recipe" ? null : e.item.grams, displayQty: e.display_qty, displayUnit: e.display_unit,
          plannedRecipeSlug: e.planned_recipe, plannedServings: e.planned_servings, note: e.note, createdAt: e.created_at, updatedAt: e.updated_at,
        };
        if (existing) await db.update(s.foodLog).set(values).where(eq(s.foodLog.id, existing.id));
        else await db.insert(s.foodLog).values({ ...values, uid: e.uid, householdId });
        imported++;
      }
    }
    return { imported, skipped };
  },

  /** A slug rename onto an existing recipe: entries follow the recipe, because they hold its slug. */
  async moveRecipe(db, fromRecipeId, toRecipeId) {
    const [from] = await db.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, fromRecipeId));
    const [to] = await db.select({ slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.id, toRecipeId));
    return from && to ? rewriteRecipeSlug(db, from.slug, to.slug) : false;
  },

  /** An in-place rename: the new slug replaces the old one in every entry. */
  async renameRecipeSlug(db, oldSlug, newSlug) {
    await rewriteRecipeSlug(db, oldSlug, newSlug);
  },
};
