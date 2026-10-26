/**
 * Daily eaten totals per person. Pure: plans, entries and nutrition lookups are passed in as plain data.
 *
 * Rules
 * - Eaten is the sum of entries. A planned meal with no entry is "planned, not confirmed", never assumed eaten.
 * - A past day with no entries is "not logged", not zero.
 * - Fibre the label or source did not report is not zero: the total is "at least", with a count of items missing it.
 */

export type EntryKind = "planned" | "skipped" | "swap" | "extra";

export interface PlannedMeal {
  /** Stable key of the planned slot, for example `<planUid>:<date>:<slot>`. */
  key: string;
  personId: string;
  date: string;
  slot: string;
  recipe: string;
  /** Servings of the recipe planned for this person. */
  servings: number;
}

export interface LoggedEntry {
  id: string;
  personId: string;
  date: string;
  kind: EntryKind;
  /** The planned meal this entry answers (kinds planned, skipped, swap). */
  plannedKey?: string;
  /** What was eaten: a recipe (with `servings`) or a food key (`<slug>` or `hf:<uid>`, with `grams`). Not used by `skipped`. */
  recipe?: string;
  servings?: number;
  foodKey?: string;
  grams?: number;
}

export interface NutrientsPer {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** Undefined means the source does not report fibre. */
  fibre_g?: number;
}

export interface NutritionLookups {
  /** Per 100 g of a food, library ingredient or household food. */
  food(key: string): NutrientsPer | undefined;
  /** Per serving of a recipe. */
  recipePerServing(slug: string): NutrientsPer | undefined;
}

export interface Totals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fibre_g: number;
  /** True when at least one item did not report fibre: `fibre_g` is a floor. */
  fibre_at_least: boolean;
  fibre_not_reported_count: number;
}

export type DayStatus = "logged" | "not_logged" | "open";

export interface DayTotals {
  personId: string;
  date: string;
  /** not_logged: a past day with no entries. open: today or later with no entries. logged: has entries. */
  status: DayStatus;
  /** Null for a not-logged day. */
  eaten: Totals | null;
  /** Planned meals with no entry yet. */
  plannedPending: Totals;
  plannedPendingKeys: string[];
  skippedKeys: string[];
  /** Entries that could not be resolved (unknown food or recipe, or no amount). They are left out of the totals. */
  unresolvedEntryIds: string[];
}

export function emptyTotals(): Totals {
  return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fibre_g: 0, fibre_at_least: false, fibre_not_reported_count: 0 };
}

function addScaled(t: Totals, n: NutrientsPer, factor: number): void {
  t.kcal += n.kcal * factor;
  t.protein_g += n.protein_g * factor;
  t.carbs_g += n.carbs_g * factor;
  t.fat_g += n.fat_g * factor;
  if (n.fibre_g === undefined) {
    t.fibre_at_least = true;
    t.fibre_not_reported_count += 1;
  } else {
    t.fibre_g += n.fibre_g * factor;
  }
}

function validAmount(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

/** Add one entry to `totals`. False when it cannot be resolved. */
function addEntry(totals: Totals, e: LoggedEntry, lookups: NutritionLookups): boolean {
  if (e.recipe !== undefined) {
    const n = lookups.recipePerServing(e.recipe);
    if (!n || !validAmount(e.servings)) return false;
    addScaled(totals, n, e.servings);
    return true;
  }
  if (e.foodKey !== undefined) {
    const n = lookups.food(e.foodKey);
    if (!n || !validAmount(e.grams)) return false;
    addScaled(totals, n, e.grams / 100);
    return true;
  }
  return false;
}

export interface DayInput {
  personId: string;
  date: string;
  /** Today's date in the household's time zone, `YYYY-MM-DD`. */
  today: string;
  meals: readonly PlannedMeal[];
  entries: readonly LoggedEntry[];
  lookups: NutritionLookups;
}

export function computeDayTotals(input: DayInput): DayTotals {
  const { personId, date, today, lookups } = input;
  const meals = input.meals.filter((m) => m.personId === personId && m.date === date);
  const entries = input.entries.filter((e) => e.personId === personId && e.date === date);

  const answered = new Set<string>();
  const skippedKeys: string[] = [];
  const unresolvedEntryIds: string[] = [];
  const eaten = emptyTotals();
  for (const e of entries) {
    if (e.plannedKey !== undefined) answered.add(e.plannedKey);
    if (e.kind === "skipped") {
      if (e.plannedKey !== undefined) skippedKeys.push(e.plannedKey);
      continue;
    }
    if (!addEntry(eaten, e, lookups)) unresolvedEntryIds.push(e.id);
  }

  const plannedPending = emptyTotals();
  const plannedPendingKeys: string[] = [];
  for (const m of meals) {
    if (answered.has(m.key)) continue;
    plannedPendingKeys.push(m.key);
    const n = lookups.recipePerServing(m.recipe);
    if (n) addScaled(plannedPending, n, m.servings);
  }

  const status: DayStatus = entries.length > 0 ? "logged" : date < today ? "not_logged" : "open";
  return {
    personId,
    date,
    status,
    eaten: status === "not_logged" ? null : eaten,
    plannedPending,
    plannedPendingKeys,
    skippedKeys,
    unresolvedEntryIds,
  };
}

export interface RangeInput extends Omit<DayInput, "personId" | "date"> {
  personIds: readonly string[];
  dates: readonly string[];
}

/** One row per person per day, people in the order given, dates ascending within a person. */
export function computeDays(input: RangeInput): DayTotals[] {
  const { personIds, dates, ...rest } = input;
  const sorted = [...dates].sort();
  return personIds.flatMap((personId) => sorted.map((date) => computeDayTotals({ ...rest, personId, date })));
}

export interface PlannedEntryDraft {
  personId: string;
  date: string;
  kind: "planned";
  plannedKey: string;
  recipe: string;
  servings: number;
}

/**
 * "Mark the rest of today as eaten as planned": drafts for planned meals that have no entry yet.
 * Skipped and swapped meals count as answered and are left alone.
 */
export function markRestAsEaten(input: {
  personId: string;
  date: string;
  meals: readonly PlannedMeal[];
  entries: readonly LoggedEntry[];
}): PlannedEntryDraft[] {
  const answered = new Set(
    input.entries.filter((e) => e.personId === input.personId && e.date === input.date && e.plannedKey !== undefined).map((e) => e.plannedKey),
  );
  return input.meals
    .filter((m) => m.personId === input.personId && m.date === input.date && !answered.has(m.key))
    .map((m) => ({ personId: m.personId, date: m.date, kind: "planned" as const, plannedKey: m.key, recipe: m.recipe, servings: m.servings }));
}
