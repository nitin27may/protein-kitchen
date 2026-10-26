import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import type { HouseholdAccess } from "../auth/household-access";
import { loggedAmountToGrams } from "../foods/units";
import { markRestAsEaten } from "../foods/totals";
import { deleteFoodEntry, logFoodEntry, markPlannedMealEaten, updateFoodEntry } from "../human/food-log";
import type { FoodScope } from "../human/household-foods";
import type { Ingredient, Recipe } from "../schemas";
import { FOOD_LOG_SLOTS, type FoodLogItemData } from "../schemas/food";
import { isAnswerKind, plannedMealsFrom, toLoggedEntries, type FoodLogRowLike } from "../food-log/keys";
import { portionsOf, type SheetFood } from "../food-log/preview";
import { readFoodEntries, readFoodEntry, readHouseholdFood, readPlanSlot, readPlanSlots, type PlanSlotRow } from "./food-log-queries";

/**
 * Transactional food-log operations. Callers run these inside `mutateHouseholdState` so the household's access is
 * refreshed and the household row is locked; the writers in lib/human/food-log.ts do the actual inserts and keep every
 * lookup household scoped. This module adds the rules the UI needs on top: a member logs only for themselves, a planned
 * meal has exactly one answer (eaten, swapped or skipped), and answering locks the slot so regenerating the plan keeps it.
 */
export class LogError extends Error {
  override name = "LogError";
  constructor(readonly code: "forbidden" | "not-found" | "invalid", message: string) { super(message); }
}

export interface LibraryRefs {
  recipes: ReadonlyMap<string, Recipe>;
  ingredients: ReadonlyMap<string, Ingredient>;
}

export const MAX_GRAMS = 5000;
export const MAX_SERVINGS = 20;

const id = z.number().int().positive();
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(200);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02").refine((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}, "That date does not exist.");
const note = z.string().trim().max(500).nullish().transform((v) => v || null);

/** What was eaten, as the person entered it. Weight comes from grams, or from a serving, piece or millilitre size on the food. */
export const ItemInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe"), recipeSlug: slug, servings: z.number().positive().max(MAX_SERVINGS) }),
  z.object({ type: z.literal("ingredient"), ingredientSlug: slug, grams: z.number().positive().max(MAX_GRAMS) }),
  z.object({ type: z.literal("food"), householdFoodUid: z.string().min(1).max(100), qty: z.number().positive().max(MAX_GRAMS), unit: z.enum(["g", "serving", "piece", "ml"]) }),
]);
export type ItemInputData = z.infer<typeof ItemInput>;

export const MarkEatenInput = z.object({ personId: id, planSlotId: id, servings: z.number().positive().max(MAX_SERVINGS).optional() });
export const MarkSkippedInput = z.object({ personId: id, planSlotId: id, note });
export const MarkSwappedInput = z.object({ personId: id, planSlotId: id, item: ItemInput, note });
export const LogExtraInput = z.object({ personIds: z.array(id).min(1).max(20), date: IsoDate, slot: z.enum(FOOD_LOG_SLOTS), item: ItemInput, note });
export const UpdateEntryInput = z.object({
  personId: id, uid: z.string().min(1).max(100), date: IsoDate.optional(), slot: z.enum(FOOD_LOG_SLOTS).optional(), item: ItemInput.optional(),
  note: z.string().trim().max(500).nullish().transform((v) => (v === undefined ? undefined : v || null)),
});
export const DeleteEntryInput = z.object({ personId: id, uid: z.string().min(1).max(100), unlockSlotId: id.optional() });
export const RestOfDayInput = z.object({ personId: id, planId: id, date: IsoDate });

export type MarkEatenData = z.infer<typeof MarkEatenInput>;
export type MarkSkippedData = z.infer<typeof MarkSkippedInput>;
export type MarkSwappedData = z.infer<typeof MarkSwappedInput>;
export type LogExtraData = z.infer<typeof LogExtraInput>;
export type UpdateEntryData = z.infer<typeof UpdateEntryInput>;
export type DeleteEntryData = z.infer<typeof DeleteEntryInput>;
export type RestOfDayData = z.infer<typeof RestOfDayInput>;

/** A member logs only for their own profile; an owner for anyone in the household (the writers then confirm membership). */
export function assertMayLog(access: Pick<HouseholdAccess, "role" | "personId">, personIds: readonly number[]): void {
  if (access.personId === null) throw new LogError("forbidden", "Finish your household profile before continuing.");
  if (access.role !== "owner" && personIds.some((p) => p !== access.personId)) throw new LogError("forbidden", "You can only log your own food.");
}

function scopeOf(access: HouseholdAccess): FoodScope {
  return { householdId: access.householdId, personId: access.personId };
}

interface ResolvedItem {
  item: FoodLogItemData;
  displayQty: number | null;
  displayUnit: string | null;
}

/** Validates the item against the library or the household's foods and turns the amount into what the writer stores. */
export async function resolveItem(db: Db, householdId: string, lib: LibraryRefs, input: ItemInputData): Promise<ResolvedItem> {
  switch (input.type) {
    case "recipe": {
      if (lib.recipes.get(input.recipeSlug)?.kind !== "recipe") throw new LogError("invalid", "That recipe is not in the library.");
      return { item: { type: "recipe", recipeSlug: input.recipeSlug, servings: input.servings }, displayQty: null, displayUnit: null };
    }
    case "ingredient": {
      if (!lib.ingredients.has(input.ingredientSlug)) throw new LogError("invalid", "That ingredient is not in the library.");
      return { item: { type: "ingredient", ingredientSlug: input.ingredientSlug, grams: input.grams }, displayQty: null, displayUnit: null };
    }
    case "food": {
      const food = await readHouseholdFood(db, householdId, input.householdFoodUid);
      if (!food) throw new LogError("not-found", "That food is not in this household.");
      if (food.archived) throw new LogError("invalid", "That food is archived. Restore it before logging it.");
      const servingG = food.servingG ?? (food.servingMl !== null && food.densityGPerMl !== null ? food.servingMl * food.densityGPerMl : undefined);
      const portions = portionsOf({
        key: "", kind: "household", name: food.name, nutrients: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
        ...(servingG !== undefined ? { servingG } : {}), ...(food.pieceG !== null ? { pieceG: food.pieceG } : {}),
        ...(food.densityGPerMl !== null ? { densityGPerMl: food.densityGPerMl } : {}),
      } satisfies SheetFood);
      const grams = loggedAmountToGrams({ qty: input.qty, unit: input.unit }, portions);
      if (!grams.ok) throw new LogError("invalid", grams.reason);
      if (grams.grams > MAX_GRAMS) throw new LogError("invalid", "That is more than 5 kg. Check the amount.");
      const shown = input.unit !== "g";
      return {
        item: { type: "food", householdFoodUid: food.uid, grams: grams.grams },
        displayQty: shown ? input.qty : null, displayUnit: shown ? input.unit : null,
      };
    }
  }
}

async function dayRows(db: Db, householdId: string, personId: number, date: string): Promise<FoodLogRowLike[]> {
  return readFoodEntries(db, householdId, { personIds: [personId], from: date, to: date });
}

/** Removes the person's earlier answers of the given kinds for this slot, so a meal has one answer. */
async function clearAnswers(db: Db, scope: FoodScope & { householdId: string }, personId: number, slot: PlanSlotRow, kinds: readonly string[]): Promise<void> {
  for (const row of await dayRows(db, scope.householdId, personId, slot.date)) {
    if (row.slot === slot.slot && isAnswerKind(row.kind) && kinds.includes(row.kind)) await deleteFoodEntry(db, scope, row.uid);
  }
}

async function lockSlot(db: Db, slot: PlanSlotRow): Promise<void> {
  await db.update(s.planSlots).set({ locked: true }).where(eq(s.planSlots.id, slot.id));
}

async function requireSlot(db: Db, householdId: string, planSlotId: number): Promise<PlanSlotRow> {
  const slot = await readPlanSlot(db, householdId, planSlotId);
  if (!slot) throw new LogError("not-found", "That planned meal is not in this household.");
  return slot;
}

function portionOf(slot: PlanSlotRow, personId: number): number {
  const servings = slot.servings[String(personId)] ?? 0;
  if (!(servings > 0)) throw new LogError("invalid", "That meal is not planned for this person.");
  return servings;
}

/** "I ate it." Replaces an earlier skipped or swapped answer. Locks the slot. */
export async function eatPlannedMeal(db: Db, access: HouseholdAccess, input: MarkEatenData): Promise<{ uid: string; created: boolean; lockedBefore: boolean }> {
  assertMayLog(access, [input.personId]);
  const slot = await requireSlot(db, access.householdId, input.planSlotId);
  const scope = scopeOf(access);
  await clearAnswers(db, scope, input.personId, slot, ["skipped", "swap"]);
  const r = await markPlannedMealEaten(db, scope, { planSlotId: slot.id, personId: input.personId, ...(input.servings !== undefined ? { servings: input.servings } : {}) });
  return { uid: r.uid, created: r.created, lockedBefore: slot.locked };
}

/** The skipped entry names the skipped meal in its item columns and is never counted as eaten. */
export async function skipPlannedMeal(db: Db, access: HouseholdAccess, input: MarkSkippedData): Promise<{ uid: string; lockedBefore: boolean }> {
  assertMayLog(access, [input.personId]);
  const slot = await requireSlot(db, access.householdId, input.planSlotId);
  const planned = portionOf(slot, input.personId);
  const scope = scopeOf(access);
  await clearAnswers(db, scope, input.personId, slot, ["planned", "skipped", "swap"]);
  await lockSlot(db, slot);
  const { uid } = await logFoodEntry(db, scope, {
    personId: input.personId, date: slot.date, slot: slot.slot as (typeof FOOD_LOG_SLOTS)[number], kind: "skipped",
    item: { type: "recipe", recipeSlug: slot.recipeSlug, servings: planned }, planId: slot.planId, plannedRecipeSlug: slot.recipeSlug, plannedServings: planned, note: input.note,
  });
  return { uid, lockedBefore: slot.locked };
}

/** "I ate something else": the entry names the item eaten and, in the planned columns, the meal it replaced. */
export async function swapPlannedMeal(db: Db, access: HouseholdAccess, lib: LibraryRefs, input: MarkSwappedData): Promise<{ uid: string; lockedBefore: boolean }> {
  assertMayLog(access, [input.personId]);
  const slot = await requireSlot(db, access.householdId, input.planSlotId);
  const planned = portionOf(slot, input.personId);
  const resolved = await resolveItem(db, access.householdId, lib, input.item);
  const scope = scopeOf(access);
  await clearAnswers(db, scope, input.personId, slot, ["planned", "skipped", "swap"]);
  await lockSlot(db, slot);
  const { uid } = await logFoodEntry(db, scope, {
    personId: input.personId, date: slot.date, slot: slot.slot as (typeof FOOD_LOG_SLOTS)[number], kind: "swap", item: resolved.item,
    displayQty: resolved.displayQty, displayUnit: resolved.displayUnit, planId: slot.planId, plannedRecipeSlug: slot.recipeSlug, plannedServings: planned, note: input.note,
  });
  return { uid, lockedBefore: slot.locked };
}

/** Food eaten outside the plan, on any date, for one or several people (same amount each). */
export async function addExtras(db: Db, access: HouseholdAccess, lib: LibraryRefs, input: LogExtraData): Promise<{ entries: { personId: number; uid: string }[] }> {
  const personIds = [...new Set(input.personIds)];
  assertMayLog(access, personIds);
  const resolved = await resolveItem(db, access.householdId, lib, input.item);
  const scope = scopeOf(access);
  const entries: { personId: number; uid: string }[] = [];
  for (const personId of personIds) {
    const { uid } = await logFoodEntry(db, scope, {
      personId, date: input.date, slot: input.slot, kind: "extra", item: resolved.item, displayQty: resolved.displayQty, displayUnit: resolved.displayUnit, note: input.note,
    });
    entries.push({ personId, uid });
  }
  return { entries };
}

async function ownEntry(db: Db, access: HouseholdAccess, personId: number, uid: string): Promise<FoodLogRowLike> {
  assertMayLog(access, [personId]);
  const entry = await readFoodEntry(db, access.householdId, uid);
  if (!entry || entry.personId !== personId) throw new LogError("not-found", "That entry is not in this log.");
  return entry;
}

function currentItem(row: FoodLogRowLike): FoodLogItemData {
  if (row.recipeSlug !== null && row.servings !== null) return { type: "recipe", recipeSlug: row.recipeSlug, servings: row.servings };
  if (row.householdFoodUid !== null && row.grams !== null) return { type: "food", householdFoodUid: row.householdFoodUid, grams: row.grams };
  return { type: "ingredient", ingredientSlug: row.ingredientSlug!, grams: row.grams! };
}

/**
 * Changes the amount, item, note, day or slot of an entry. An answer to a planned meal (eaten, swapped, skipped) keeps its
 * day and slot, because the planned key depends on them; an eaten meal may only change its servings and a skipped one its note.
 */
export async function editEntry(db: Db, access: HouseholdAccess, lib: LibraryRefs, input: UpdateEntryData): Promise<void> {
  const row = await ownEntry(db, access, input.personId, input.uid);
  const answer = isAnswerKind(row.kind);
  if (answer && ((input.date !== undefined && input.date !== row.date) || (input.slot !== undefined && input.slot !== row.slot))) {
    throw new LogError("invalid", "A planned meal keeps its day and slot. Delete it and log the food again to move it.");
  }
  if (row.kind === "skipped" && input.item !== undefined) throw new LogError("invalid", "A skipped meal has no amount to change.");
  if (row.kind === "planned" && input.item !== undefined && (input.item.type !== "recipe" || input.item.recipeSlug !== row.recipeSlug)) {
    throw new LogError("invalid", "An eaten planned meal can only change its servings. Use Swapped to record something else.");
  }
  let item = currentItem(row);
  let displayQty = row.displayQty;
  let displayUnit = row.displayUnit;
  if (input.item !== undefined) {
    const resolved = await resolveItem(db, access.householdId, lib, input.item);
    item = resolved.item;
    displayQty = resolved.displayQty;
    displayUnit = resolved.displayUnit;
  }
  await updateFoodEntry(db, scopeOf(access), row.uid, {
    date: input.date ?? row.date, slot: (input.slot ?? row.slot) as (typeof FOOD_LOG_SLOTS)[number], kind: row.kind, item, displayQty, displayUnit,
    planId: row.planId, plannedRecipeSlug: row.plannedRecipeSlug, plannedServings: row.plannedServings,
    note: input.note === undefined ? row.note : input.note,
  });
}

/**
 * Removes an entry (the Undo of every add). `unlockSlotId` hands back the lock that logging added; it is honoured only when
 * the entry was an answer to that very slot and nobody else's answer for it remains.
 */
export async function removeEntry(db: Db, access: HouseholdAccess, input: DeleteEntryData): Promise<{ removed: boolean }> {
  const row = await ownEntry(db, access, input.personId, input.uid);
  const removed = await deleteFoodEntry(db, scopeOf(access), row.uid);
  if (removed && input.unlockSlotId !== undefined && isAnswerKind(row.kind)) {
    const slot = await readPlanSlot(db, access.householdId, input.unlockSlotId);
    if (slot && slot.date === row.date && slot.slot === row.slot && slot.recipeSlug === row.plannedRecipeSlug) {
      const people = Object.keys(slot.servings).map(Number);
      const rest = await readFoodEntries(db, access.householdId, { personIds: people, from: slot.date, to: slot.date });
      if (!rest.some((r) => r.slot === slot.slot && isAnswerKind(r.kind))) {
        await db.update(s.planSlots).set({ locked: false }).where(and(eq(s.planSlots.id, slot.id), eq(s.planSlots.planId, slot.planId)));
      }
    }
  }
  return { removed };
}

/** Marks every unanswered planned meal of the day as eaten as planned, in the caller's single transaction. Idempotent. */
export async function eatRestOfDay(db: Db, access: HouseholdAccess, input: RestOfDayData): Promise<{ marked: number }> {
  assertMayLog(access, [input.personId]);
  const slots = await readPlanSlots(db, access.householdId, input.planId, input.date);
  const meals = plannedMealsFrom(slots, [input.personId]);
  const entries = toLoggedEntries(await dayRows(db, access.householdId, input.personId, input.date), meals);
  const drafts = markRestAsEaten({ personId: String(input.personId), date: input.date, meals, entries });
  const scope = scopeOf(access);
  for (const draft of drafts) {
    const meal = meals.find((m) => m.key === draft.plannedKey)!;
    await markPlannedMealEaten(db, scope, { planSlotId: meal.planSlotId, personId: input.personId });
  }
  return { marked: drafts.length };
}
