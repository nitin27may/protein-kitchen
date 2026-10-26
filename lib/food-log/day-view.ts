/**
 * View models for Today and plan review, built from totals. Pure.
 */
import { computeDays, computeDayTotals, emptyTotals, type DayStatus, type EntryKind, type NutritionLookups, type PlannedMeal, type Totals } from "../foods/totals";
import { quantityText, trimNumber, type AmountUnit } from "./format";
import { toLoggedEntries, type FoodLogRowLike } from "./keys";

export interface Names {
  recipe(slug: string): string;
  ingredient(slug: string): string;
  /** Household food by uid. */
  food(uid: string): string;
}

export interface EntryView {
  uid: string;
  personId: number;
  date: string;
  slot: string;
  kind: EntryKind;
  name: string;
  /** `110 g`, `1.5 servings`, `2 pieces (110 g)`. Empty for a skipped meal. */
  amount: string;
  proteinG: number;
  kcal: number;
  /** False when the food or recipe can no longer be found: it is listed but not counted. */
  resolved: boolean;
  note: string | null;
  plannedName: string | null;
  plannedRecipeSlug: string | null;
  /** What the entry holds, for editing and for putting it back after a delete. Null for a skipped meal. */
  item: { type: "recipe"; recipeSlug: string; servings: number } | { type: "ingredient"; ingredientSlug: string; grams: number } | { type: "food"; householdFoodUid: string; grams: number } | null;
}

function itemOf(r: FoodLogRowLike): EntryView["item"] {
  if (r.kind === "skipped") return null;
  if (r.recipeSlug !== null && r.servings !== null) return { type: "recipe", recipeSlug: r.recipeSlug, servings: r.servings };
  if (r.grams === null) return null;
  if (r.householdFoodUid !== null) return { type: "food", householdFoodUid: r.householdFoodUid, grams: r.grams };
  return r.ingredientSlug !== null ? { type: "ingredient", ingredientSlug: r.ingredientSlug, grams: r.grams } : null;
}

function amountOf(r: FoodLogRowLike): string {
  if (r.recipeSlug !== null && r.servings !== null) return quantityText(r.servings, "serving");
  if (r.grams === null) return "";
  if (r.displayQty !== null && r.displayUnit !== null && ["serving", "piece", "ml"].includes(r.displayUnit)) {
    return `${quantityText(r.displayQty, r.displayUnit as AmountUnit)} (${trimNumber(r.grams)} g)`;
  }
  return `${trimNumber(r.grams)} g`;
}

export function entryViews(rows: readonly FoodLogRowLike[], lookups: NutritionLookups, names: Names): EntryView[] {
  const entries = toLoggedEntries(rows);
  return rows.map((r, i) => {
    const e = entries[i]!;
    const t = emptyTotals();
    let resolved = r.kind === "skipped";
    let name: string;
    if (r.kind === "skipped") name = names.recipe(r.recipeSlug ?? r.plannedRecipeSlug ?? "");
    else if (r.recipeSlug !== null) name = names.recipe(r.recipeSlug);
    else if (r.householdFoodUid !== null) name = names.food(r.householdFoodUid);
    else name = names.ingredient(r.ingredientSlug ?? "");
    if (r.kind !== "skipped") {
      const n = e.recipe !== undefined ? lookups.recipePerServing(e.recipe) : e.foodKey !== undefined ? lookups.food(e.foodKey) : undefined;
      const factor = e.recipe !== undefined ? e.servings : e.grams !== undefined ? e.grams / 100 : undefined;
      if (n && factor !== undefined) {
        resolved = true;
        t.protein_g = n.protein_g * factor;
        t.kcal = n.kcal * factor;
      }
    }
    return {
      uid: r.uid, personId: r.personId, date: r.date, slot: r.slot, kind: r.kind, name, amount: r.kind === "skipped" ? "" : amountOf(r),
      proteinG: t.protein_g, kcal: t.kcal, resolved, note: r.note,
      plannedName: r.plannedRecipeSlug !== null ? names.recipe(r.plannedRecipeSlug) : null, plannedRecipeSlug: r.plannedRecipeSlug, item: itemOf(r),
    };
  });
}

export type MealStatus = "pending" | "eaten" | "swapped" | "skipped";

export interface MealAnswer {
  status: MealStatus;
  entry: EntryView | null;
}

/** What happened to one planned meal, from the person's entries for that day. */
export function mealAnswer(meal: Pick<PlannedMeal, "personId" | "date" | "slot" | "recipe">, views: readonly EntryView[]): MealAnswer {
  const hit = views.find((v) => String(v.personId) === meal.personId && v.date === meal.date && v.slot === meal.slot && v.kind !== "extra" && v.plannedRecipeSlug === meal.recipe);
  if (!hit) return { status: "pending", entry: null };
  return { status: hit.kind === "planned" ? "eaten" : hit.kind === "swap" ? "swapped" : "skipped", entry: hit };
}

export interface EatenBar {
  status: DayStatus;
  /** Null when the day is past and nothing was logged. */
  eaten: Totals | null;
  pendingProteinG: number;
  /** Planned meals with no answer yet. */
  pendingCount: number;
}

/** Eaten and still-planned protein for one person on one day. */
export function eatenBar(args: { personId: number; date: string; today: string; meals: readonly PlannedMeal[]; rows: readonly FoodLogRowLike[]; lookups: NutritionLookups }): EatenBar {
  const entries = toLoggedEntries(args.rows, args.meals);
  const d = computeDayTotals({ personId: String(args.personId), date: args.date, today: args.today, meals: args.meals, entries, lookups: args.lookups });
  return { status: d.status, eaten: d.eaten, pendingProteinG: d.plannedPending.protein_g, pendingCount: d.plannedPendingKeys.length };
}

export type Marker = "ate_plan" | "swapped" | "skipped" | "partial" | "extras" | "not_logged" | "open" | "none";

export const MARKER_TEXT: Record<Marker, string> = {
  ate_plan: "Ate as planned",
  swapped: "Swapped",
  skipped: "Skipped",
  partial: "Part logged",
  extras: "Logged",
  not_logged: "Not logged",
  open: "Not yet",
  none: "",
};

export interface ReviewPerson {
  id: number;
  name: string;
  targetG: number;
}

export interface ReviewCell {
  personId: number;
  date: string;
  plannedProteinG: number;
  /** Null when the day is past and nothing was logged. */
  eatenProteinG: number | null;
  marker: Marker;
}

export interface ReviewSummary {
  personId: number;
  name: string;
  loggedDays: number;
  totalDays: number;
  /** Mean eaten protein over logged days only, or null when none are logged. */
  averageG: number | null;
  targetG: number;
}

export function reviewPlan(args: {
  people: readonly ReviewPerson[];
  dates: readonly string[];
  today: string;
  meals: readonly PlannedMeal[];
  rows: readonly FoodLogRowLike[];
  lookups: NutritionLookups;
}): { cells: ReviewCell[]; summaries: ReviewSummary[] } {
  const entries = toLoggedEntries(args.rows, args.meals);
  const days = computeDays({ personIds: args.people.map((p) => String(p.id)), dates: args.dates, today: args.today, meals: args.meals, entries, lookups: args.lookups });
  const cells: ReviewCell[] = days.map((d) => {
    const mine = args.rows.filter((r) => String(r.personId) === d.personId && r.date === d.date);
    const dayMeals = args.meals.filter((m) => m.personId === d.personId && m.date === d.date);
    const planned = emptyTotals();
    for (const m of dayMeals) {
      const n = args.lookups.recipePerServing(m.recipe);
      if (n) planned.protein_g += n.protein_g * m.servings;
    }
    return {
      personId: Number(d.personId), date: d.date, plannedProteinG: planned.protein_g, eatenProteinG: d.eaten ? d.eaten.protein_g : null,
      marker: markerFor(d.status, dayMeals.length, d.plannedPendingKeys.length, mine),
    };
  });
  const summaries = args.people.map((p): ReviewSummary => {
    // A logged day always has an eaten total.
    const logged = days.filter((d) => d.personId === String(p.id) && d.status === "logged");
    const sum = logged.reduce((acc, d) => acc + (d.eaten as Totals).protein_g, 0);
    return { personId: p.id, name: p.name, loggedDays: logged.length, totalDays: args.dates.length, averageG: logged.length ? sum / logged.length : null, targetG: p.targetG };
  });
  return { cells, summaries };
}

function markerFor(status: DayStatus, meals: number, pending: number, rows: readonly FoodLogRowLike[]): Marker {
  if (status === "not_logged") return meals === 0 ? "none" : "not_logged";
  if (status === "open") return meals === 0 ? "none" : "open";
  const answers = rows.filter((r) => r.kind === "planned" || r.kind === "swap" || r.kind === "skipped");
  if (meals > 0 && pending > 0) return "partial";
  if (answers.some((r) => r.kind === "swap")) return "swapped";
  if (answers.some((r) => r.kind === "skipped")) return "skipped";
  if (answers.length > 0) return "ate_plan";
  return "extras";
}
