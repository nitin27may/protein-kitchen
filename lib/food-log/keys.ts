/**
 * Glue between database rows and the pure totals in lib/foods/totals. Pure: imports nothing from lib/server, lib/db,
 * lib/auth, lib/human or next/*.
 *
 * A planned meal is matched to its log entry by `${personId}:${date}:${slot}`. The key does not contain a plan id, so an
 * answer survives plan regeneration (locked slots keep their meal) and a new plan for the same dates.
 */
import { householdKey } from "../foods/catalog";
import type { EntryKind, LoggedEntry, PlannedMeal } from "../foods/totals";

export function plannedKey(personId: number | string, date: string, slot: string): string {
  return `${personId}:${date}:${slot}`;
}

export interface PlanSlotInput {
  id: number;
  date: string;
  slot: string;
  recipeSlug: string;
  /** Servings by person id (as a string), as the plan view stores them. */
  servings: Readonly<Record<string, number>>;
}

export interface MealRef extends PlannedMeal {
  planSlotId: number;
}

/** One planned meal per person who has a portion in the slot. People with no portion do not eat that meal. */
export function plannedMealsFrom(slots: readonly PlanSlotInput[], personIds: readonly number[]): MealRef[] {
  const meals: MealRef[] = [];
  for (const sl of slots) {
    for (const personId of personIds) {
      const servings = sl.servings[String(personId)] ?? 0;
      if (!(servings > 0)) continue;
      meals.push({ key: plannedKey(personId, sl.date, sl.slot), personId: String(personId), date: sl.date, slot: sl.slot, recipe: sl.recipeSlug, servings, planSlotId: sl.id });
    }
  }
  return meals;
}

/** A log row with the household food named by uid (the database stores its id). */
export interface FoodLogRowLike {
  uid: string;
  personId: number;
  date: string;
  slot: string;
  kind: EntryKind;
  recipeSlug: string | null;
  servings: number | null;
  ingredientSlug: string | null;
  householdFoodUid: string | null;
  grams: number | null;
  displayQty: number | null;
  displayUnit: string | null;
  planId: number | null;
  plannedRecipeSlug: string | null;
  plannedServings: number | null;
  note: string | null;
}

const ANSWER_KINDS: ReadonlySet<EntryKind> = new Set(["planned", "skipped", "swap"]);

export function isAnswerKind(kind: EntryKind): boolean {
  return ANSWER_KINDS.has(kind);
}

/**
 * Rows as totals entries. A skipped entry carries no item (it names the skipped meal and is never eaten). An answer whose
 * planned recipe no longer matches the meal now planned at that key (the slot was changed after the answer) does not
 * answer the new meal: the new meal is pending again.
 */
export function toLoggedEntries(rows: readonly FoodLogRowLike[], meals: readonly PlannedMeal[] = []): LoggedEntry[] {
  const recipeAt = new Map(meals.map((m) => [m.key, m.recipe]));
  return rows.map((r) => {
    const e: LoggedEntry = { id: r.uid, personId: String(r.personId), date: r.date, kind: r.kind };
    if (isAnswerKind(r.kind)) {
      const key = plannedKey(r.personId, r.date, r.slot);
      const planned = recipeAt.get(key);
      if (planned === undefined || planned === r.plannedRecipeSlug) e.plannedKey = key;
    }
    if (r.kind === "skipped") return e;
    if (r.recipeSlug !== null && r.servings !== null) {
      e.recipe = r.recipeSlug;
      e.servings = r.servings;
    } else if (r.grams !== null) {
      const foodKey = r.householdFoodUid !== null ? householdKey(r.householdFoodUid) : r.ingredientSlug;
      if (foodKey !== null) {
        e.foodKey = foodKey;
        e.grams = r.grams;
      }
    }
    return e;
  });
}
