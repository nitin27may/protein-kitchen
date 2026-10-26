"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionDenial, requireMember, type AccessPolicy } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { memberHouseholdAccess, type HouseholdAccess } from "@/lib/auth/household-access";
import type { UsageMap } from "@/lib/foods/catalog";
import { FoodDataError } from "@/lib/human/household-foods";
import type { Db } from "@/lib/db/client";
import { nutritionLookups } from "@/lib/food-log/lookups";
import type { SheetFood } from "@/lib/food-log/preview";
import { RECIPE_PREFIX } from "@/lib/food-log/preview";
import { getData, getDb } from "@/lib/server/context";
import { readFoodUsage, readHouseholdFoods } from "@/lib/server/food-log-queries";
import {
  addExtras, DeleteEntryInput, editEntry, eatPlannedMeal, eatRestOfDay, LogError, LogExtraInput, MarkEatenInput, MarkSkippedInput,
  MarkSwappedInput, removeEntry, RestOfDayInput, skipPlannedMeal, swapPlannedMeal, UpdateEntryInput,
} from "@/lib/server/food-log-service";
import { mutateHouseholdState } from "@/lib/server/household-plans";

/**
 * Server actions for the food log. Each one checks the session and role before reading anything: an owner may act for
 * anyone in the household, a member only for themselves (`actionDenial({ personId })`; several people at once need the
 * owner). The writers in lib/human/food-log.ts re-check that every person and food belongs to the household, and the
 * whole action runs in one transaction.
 */
export type LogResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Policy for the person ids in a request: one person means that person, several different people mean the owner. */
function policyFor(ids: unknown): AccessPolicy {
  const list = Array.isArray(ids) ? ids : [ids];
  const valid = new Set(list.filter((x): x is number => Number.isInteger(x) && (x as number) > 0));
  if (valid.size > 1) return "owner";
  return valid.size === 1 && list.every((x) => valid.has(x as number)) ? { personId: [...valid][0]! } : "member";
}

function refresh() {
  revalidatePath("/", "layout");
}

async function mutate<S extends z.ZodTypeAny, T extends object>(
  schema: S, raw: unknown, work: (db: Db, access: HouseholdAccess, input: z.output<S>) => Promise<T>,
): Promise<LogResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That entry is not valid.");
  try {
    const db = await getDb();
    const access = await memberHouseholdAccess(db, await requireMember());
    const out = await mutateHouseholdState(db, access, (tx) => work(tx, access, parsed.data));
    refresh();
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof FoodDataError || error instanceof LogError || error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}

const lib = () => getData();

export async function markMealEaten(input: z.input<typeof MarkEatenInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(MarkEatenInput, input, (db, access, v) => eatPlannedMeal(db, access, v));
}

export async function markMealSkipped(input: z.input<typeof MarkSkippedInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(MarkSkippedInput, input, (db, access, v) => skipPlannedMeal(db, access, v));
}

export async function markMealSwapped(input: z.input<typeof MarkSwappedInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(MarkSwappedInput, input, (db, access, v) => swapPlannedMeal(db, access, lib(), v));
}

export async function logExtra(input: z.input<typeof LogExtraInput>) {
  const denied = await actionDenial(policyFor(input?.personIds));
  if (denied) return denied;
  return mutate(LogExtraInput, input, (db, access, v) => addExtras(db, access, lib(), v));
}

export async function updateEntry(input: z.input<typeof UpdateEntryInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(UpdateEntryInput, input, async (db, access, v) => { await editEntry(db, access, lib(), v); return {}; });
}

export async function deleteEntry(input: z.input<typeof DeleteEntryInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(DeleteEntryInput, input, (db, access, v) => removeEntry(db, access, v));
}

export async function markRestOfDayEaten(input: z.input<typeof RestOfDayInput>) {
  const denied = await actionDenial(policyFor(input?.personId));
  if (denied) return denied;
  return mutate(RestOfDayInput, input, (db, access, v) => eatRestOfDay(db, access, v));
}

export interface FoodCatalogPayload {
  foods: SheetFood[];
  usage: UsageMap;
  hasHouseholdFoods: boolean;
}

/** Everything the add sheet searches: library ingredients, library recipes (per serving) and the household's own foods. */
export async function loadFoodCatalog(): Promise<LogResult<FoodCatalogPayload>> {
  const denied = await actionDenial();
  if (denied) return denied;
  try {
    const db = await getDb();
    const access = await memberHouseholdAccess(db, await requireMember());
    const data = getData();
    const owned = await readHouseholdFoods(db, access.householdId, { includeArchived: false });
    const lookups = nutritionLookups(data.recipes, data.ingredients, owned);
    const foods: SheetFood[] = [];
    for (const i of data.ingredients.values()) {
      foods.push({ key: i.slug, kind: "ingredient", name: i.display_name ?? i.name, state: i.state, aliases: i.aliases, nutrients: i.per100g });
    }
    for (const r of data.recipes.values()) {
      const n = r.kind === "recipe" ? lookups.recipePerServing(r.slug) : undefined;
      if (n) foods.push({ key: `${RECIPE_PREFIX}${r.slug}`, kind: "recipe", name: r.name, nutrients: n });
    }
    for (const f of owned) {
      const servingG = f.servingG ?? (f.servingMl !== null && f.densityGPerMl !== null ? f.servingMl * f.densityGPerMl : undefined);
      foods.push({
        key: `hf:${f.uid}`, kind: "household", name: f.name, state: f.state, ...(f.brand ? { brand: f.brand } : {}),
        nutrients: { kcal: f.kcal, protein_g: f.proteinG, carbs_g: f.carbsG, fat_g: f.fatG, ...(f.fibreG !== null ? { fibre_g: f.fibreG } : {}) },
        ...(servingG !== undefined ? { servingG } : {}), ...(f.servingLabel ? { servingLabel: f.servingLabel } : {}),
        ...(f.pieceG !== null ? { pieceG: f.pieceG } : {}), ...(f.pieceLabel ? { pieceLabel: f.pieceLabel } : {}),
        ...(f.densityGPerMl !== null ? { densityGPerMl: f.densityGPerMl } : {}),
      });
    }
    return { ok: true, foods, usage: await readFoodUsage(db, access.householdId), hasHouseholdFoods: owned.length > 0 };
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}
