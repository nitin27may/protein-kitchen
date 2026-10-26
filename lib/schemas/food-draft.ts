import { z } from "zod";
import { FOOD_FORM_STATES, OPTIONAL_MICRO_KEYS, type FoodDraft } from "../foods/form";

/**
 * What the foods form sends to a server action: the numbers as printed on the label, never converted figures. The server
 * converts to per 100 g itself (lib/foods/form.ts). Shape and size only; the label rules live in lib/foods/validate.ts.
 */
const num = z.number().finite();
const short = (max: number) => z.string().trim().min(1).max(max);
const microKey = z.enum(OPTIONAL_MICRO_KEYS);

export const FoodDraftInput = z.object({
  name: z.string().trim().max(120),
  brand: short(80).optional(),
  barcode: z.string().regex(/^\d{8,14}$/, "A barcode is 8 to 14 digits.").optional(),
  basis: z.enum(["per_serving", "per_100g", "per_100ml"]),
  servingSize: num.optional(),
  servingUnit: z.enum(["g", "ml"]),
  servingLabel: short(60).optional(),
  pieceLabel: short(60).optional(),
  pieceG: num.optional(),
  state: z.enum(FOOD_FORM_STATES),
  energy: z.object({ value: num, unit: z.enum(["kcal", "kJ"]) }).optional(),
  protein_g: num.optional(),
  carbs_g: num.optional(),
  fat_g: num.optional(),
  fibre_g: num.optional(),
  sugar_g: num.optional(),
  sat_fat_g: num.optional(),
  sodium: num.optional(),
  sodiumUnit: z.enum(["mg", "g"]),
  micros: z.record(microKey, num).optional(),
  density: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pack"), packNetG: num, packVolumeMl: num }),
    z.object({ kind: z.literal("serving"), servingG: num, servingMl: num }),
    z.object({ kind: z.literal("assumed") }),
  ]).optional(),
  ingredientsText: z.string().trim().min(1).max(4000).optional(),
  isDairy: z.boolean(),
  containsOnionGarlic: z.boolean(),
  dietChecked: z.boolean(),
}).strict();

/** The draft plus the person's confirmation that they checked the warned values against the label. */
export const FoodSaveInput = z.object({ draft: FoodDraftInput, checkedAgainstLabel: z.boolean() }).strict();
export type FoodSaveData = { draft: FoodDraft; checkedAgainstLabel: boolean };
