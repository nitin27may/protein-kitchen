import { z } from "zod";
import { MEAL_SLOTS, STATES } from "./index";
import { MICRO_LABELS } from "../nutrition/labels";

/**
 * Structural validation for the household master list and the food log. Only shape and sign are checked here; the
 * nutrition rules (label arithmetic, serving consistency, diet flags) live in lib/foods/validate.ts. Column names in the
 * database are snake_case; these inputs are camelCase and map one to one.
 */
export const FOOD_SOURCES = ["LABEL", "OFF", "MANUAL"] as const;
export const FOOD_LABEL_BASES = ["per_serving", "per_100g", "per_100ml"] as const;
export const FOOD_LOG_KINDS = ["planned", "skipped", "swap", "extra"] as const;
export const FOOD_LOG_SLOTS = MEAL_SLOTS;
/** Micronutrient keys are the ones ingredient_micros uses (see data/nutrients/micros.json). */
export const FOOD_MICRO_KEYS = MICRO_LABELS.map((m) => m.key) as [string, ...string[]];

const nonNeg = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).nullish().transform((v) => v ?? null);
const isoTimestamp = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case").max(200);
const microKey = z.enum(FOOD_MICRO_KEYS);

export const HouseholdFoodInput = z.object({
  name: text(120),
  brand: optionalText(80),
  /** 8 to 14 digits (EAN-8, UPC-A, EAN-13, GTIN-14). */
  barcode: z.string().regex(/^\d{8,14}$/, "A barcode is 8 to 14 digits").nullish().transform((v) => v ?? null),
  state: z.enum(STATES).default("ready"),
  aisle: text(40).default("packaged"),
  // Per 100 g, as confirmed by the person.
  kcal: nonNeg,
  proteinG: nonNeg,
  carbsG: nonNeg,
  fatG: nonNeg,
  /** null means the label does not report fibre. It is never stored as 0. */
  fibreG: nonNeg.nullish().transform((v) => v ?? null),
  per100gMicros: z.record(microKey, nonNeg).default({}),
  /** Micronutrient keys the label does not report (same keys as ingredient_micros). */
  notReported: z.array(microKey).default([]),
  servingLabel: optionalText(60),
  servingG: positive.nullish().transform((v) => v ?? null),
  servingMl: positive.nullish().transform((v) => v ?? null),
  densityGPerMl: positive.nullish().transform((v) => v ?? null),
  pieceLabel: optionalText(60),
  pieceG: positive.nullish().transform((v) => v ?? null),
  labelBasis: z.enum(FOOD_LABEL_BASES),
  /** The numbers as printed on the label, before conversion to per 100 g. Free-form JSON object. */
  labelValues: z.record(z.string().max(60), z.unknown()).default({}),
  source: z.enum(FOOD_SOURCES),
  sourceId: optionalText(120),
  /** Where each field came from, for example `{ "proteinG": "label", "fibreG": "edited" }`. */
  fieldOrigins: z.record(z.string().max(60), z.string().max(40)).default({}),
  ingredientsText: z.string().trim().max(4000).nullish().transform((v) => v ?? null),
  isDairy: z.boolean().default(false),
  containsOnionGarlic: z.boolean().default(false),
  /** Diet-rule hits found in the ingredients text (for example "gelatin"). */
  dietFlagsFound: z.array(text(60)).default([]),
  dietCheckedAt: isoTimestamp.nullish().transform((v) => v ?? null),
});
export type HouseholdFoodInputData = z.input<typeof HouseholdFoodInput>;
export type HouseholdFoodData = z.output<typeof HouseholdFoodInput>;

/** An update replaces the whole confirmed record, so it takes the same shape as a create. */
export const HouseholdFoodUpdate = HouseholdFoodInput;
export type HouseholdFoodUpdateData = HouseholdFoodData;

const entryBase = {
  personId: z.number().int().positive(),
  date: isoDate,
  slot: z.enum(FOOD_LOG_SLOTS),
  kind: z.enum(FOOD_LOG_KINDS),
  displayQty: positive.nullish().transform((v) => v ?? null),
  displayUnit: optionalText(30),
  /** The plan this entry answers, when it came from a planned meal. */
  planId: z.number().int().positive().nullish().transform((v) => v ?? null),
  plannedRecipeSlug: slug.nullish().transform((v) => v ?? null),
  plannedServings: positive.nullish().transform((v) => v ?? null),
  note: z.string().trim().max(500).nullish().transform((v) => v ?? null),
};

/** Exactly one of a recipe (servings), a library ingredient (grams) or a household food (grams). */
export const FoodLogItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe"), recipeSlug: slug, servings: positive }),
  z.object({ type: z.literal("ingredient"), ingredientSlug: slug, grams: positive }),
  z.object({ type: z.literal("food"), householdFoodUid: z.string().min(1).max(100), grams: positive }),
]);
export type FoodLogItemData = z.infer<typeof FoodLogItem>;

export const FoodLogEntryInput = z.object({ ...entryBase, item: FoodLogItem });
export type FoodLogEntryInputData = z.input<typeof FoodLogEntryInput>;
export type FoodLogEntryData = z.output<typeof FoodLogEntryInput>;

/** An edit may change the day, slot, item, amount, kind and note. The person never changes. */
export const FoodLogEntryUpdate = FoodLogEntryInput.omit({ personId: true });
export type FoodLogEntryUpdateData = z.output<typeof FoodLogEntryUpdate>;
