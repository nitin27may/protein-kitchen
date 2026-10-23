import { z } from "zod";

export const STATES = ["dry", "cooked", "raw", "ready"] as const;
export const SOURCES = ["CNF", "USDA", "IFCT"] as const;
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack", "shake"] as const;
export const ADVANCE_PREP_KINDS = ["soak", "sprout", "marinate", "set_dahi", "thaw", "overnight"] as const;
export const EVIDENCE_GRADES = ["strong", "moderate", "weak", "myth", "practical"] as const;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case");
const nonNeg = z.number().nonnegative();

export const MacrosSchema = z
  .object({
    kcal: nonNeg,
    protein_g: nonNeg,
    carbs_g: nonNeg,
    fat_g: nonNeg,
    fibre_g: nonNeg,
  })
  .strict();

/** A countable serving, for example 2 rotis. Optional: recipes without it show grams. */
export const ServingUnitSchema = z
  .object({
    singular: z.string().min(1).max(30),
    plural: z.string().min(1).max(30),
    per_serving: z.number().positive(),
  })
  .strict();
export type ServingUnit = z.infer<typeof ServingUnitSchema>;

export const IngredientSchema = z
  .object({
    slug,
    name: z.string().min(1),
    /** Short name for the UI. `name` stays faithful to the source database entry. */
    display_name: z.string().min(1).max(40).optional(),
    aliases: z.array(z.string()),
    state: z.enum(STATES),
    cooked_yield: z.number().positive().optional(),
    per100g: MacrosSchema,
    source: z.enum(SOURCES),
    source_id: z.string().min(1),
    aisle: z.string().min(1),
    pack_size_g: z.number().positive().nullable(),
    where_to_buy: z.array(z.string()),
    is_pantry_staple: z.boolean(),
    contains_onion_garlic: z.boolean(),
    is_dairy: z.boolean(),
    /** File name inside public/ingredient-images. Filled from data/images.json, not hand-written. */
    image: z.string().optional(),
    image_credit: z.string().optional(),
    /** How to eat it for the most nutrition. Filled from data/ingredient-notes.json. */
    note: z.string().optional(),
  })
  .strict();

export const MicrosEntrySchema = z
  .object({
    source: z.enum(SOURCES),
    source_id: z.string().min(1),
    per100g: z.record(z.string(), z.number()),
    not_reported: z.array(z.string()),
  })
  .strict();
export const MicrosFileSchema = z.record(z.string(), MicrosEntrySchema);

// Macros are deliberately absent: kcal/protein/carbs/fat/fibre on a recipe is rejected by .strict().
const IngredientItemSchema = z
  .object({
    ingredient: slug,
    grams: z.number().positive(),
    display_qty: z.number().positive().optional(),
    display_unit: z.string().optional(),
    optional: z.boolean().optional(),
  })
  .strict();

/**
 * A part of a meal that has its own recipe (kind "component"). `grams` is the part as eaten in this recipe; the part
 * is made at that fraction of its own yield, and its yield is the sum of its item weights. So a part must list every
 * gram that ends up in it, water included: a hidden "water is not counted" makes the yield too small and the portion
 * macros too high.
 */
const ComponentItemSchema = z
  .object({
    component: slug,
    grams: z.number().positive(),
    /** Friendly count for display only, for example 8 "patties". */
    display_qty: z.number().positive().optional(),
    display_unit: z.string().min(1).optional(),
    /** Role of the part in this meal, for example "Dip" or "Dressing". Display only. */
    label: z.string().min(1).max(40).optional(),
    /** Ready-state ingredient that stands in for this part when it is bought instead of made. */
    alt_ingredient: slug.optional(),
    optional: z.boolean().optional(),
  })
  .strict();

export const RecipeItemSchema = z.union([IngredientItemSchema, ComponentItemSchema]);

export const AdvancePrepSchema = z
  .object({
    kind: z.enum(ADVANCE_PREP_KINDS),
    ingredient: slug.optional(),
    grams: z.number().positive().optional(),
    lead_hours: z.number().positive(),
    instruction: z.string().min(1),
  })
  .strict();

export const StepSchema = z
  .object({
    text: z.string().min(1),
    technique: slug.optional(),
    timer_sec: z.number().int().positive().optional(),
    /** How you know the step is done: colour, texture, sound, temperature. */
    cue: z.string().min(5).max(220).optional(),
    /** One common mistake or a time-saving hint for this step. */
    tip: z.string().min(5).max(220).optional(),
  })
  .strict();

export const RecipeSchema = z
  .object({
    slug,
    name: z.string().min(1),
    kind: z.enum(["recipe", "component"]),
    family: slug,
    meal_slots: z.array(z.enum(MEAL_SLOTS)).min(1),
    cuisine: z.string().min(1),
    is_indian: z.boolean(),
    servings: z.number().positive(),
    prep_min: z.number().nonnegative(),
    active_min: z.number().nonnegative(),
    total_min: z.number().nonnegative(),
    equipment: z.array(z.string()),
    tags: z.array(z.string()),
    fridge_days: z.number().int().nonnegative(),
    /** Storage and reheating advice. Optional: a default is built from fridge_days. */
    storage: z.string().min(10).max(320).optional(),
    serving_unit: ServingUnitSchema.optional(),
    status: z.enum(["draft", "tested"]),
    items: z.array(RecipeItemSchema).min(1),
    advance_prep: z.array(AdvancePrepSchema),
    steps: z.array(StepSchema).min(1),
    // Human-owned fields. The agent never writes these (CLAUDE.md rule 6).
    rating: z.number().int().min(1).max(5).optional(),
    favourite: z.boolean().optional(),
    banned: z.boolean().optional(),
    notes: z.string().optional(),
    /** File name inside public/recipe-images. Optional: the UI falls back to a typographic card. */
    image: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\.(jpg|jpeg|png|webp)$/, "image must be a file name in public/recipe-images")
      .optional(),
    image_credit: z.string().optional(),
  })
  .strict();

export const TechniqueFrontMatterSchema = z
  .object({
    title: z.string().min(1),
    tags: z.array(z.string()),
  })
  .strict();

export const HabitSchema = z
  .object({
    slug,
    title: z.string().min(1),
    category: z.enum(["morning_drink", "daily_basic", "evening_prep_generic"]),
    evidence_grade: z.enum(EVIDENCE_GRADES),
    evidence_note: z.string().min(1),
    source_url: z.string().nullable(),
    caution: z.string().nullable(),
    default_on: z.boolean(),
  })
  .strict();

export type Macros = z.infer<typeof MacrosSchema>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeItem = z.infer<typeof RecipeItemSchema>;
export type Habit = z.infer<typeof HabitSchema>;
export type MicrosFile = z.infer<typeof MicrosFileSchema>;

export const SEXES = ["male", "female", "other"] as const;
export const ACTIVITY_LEVELS = ["sedentary", "light", "moderate", "high"] as const;
export const MAX_PLAN_DAYS = 31;

export const PersonSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sex: z.enum(SEXES),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    height_cm: z.number().min(100).max(250),
    weight_kg: z.number().min(30).max(300),
    activity_level: z.enum(ACTIVITY_LEVELS),
    /** Fixed grams per day, or derived from weight when protein_g_per_kg is set. One of the two. */
    protein_target_g: z.number().positive().optional(),
    protein_g_per_kg: z.number().min(0.6).max(3).optional(),
    kcal_target: z.number().min(1000).max(6000).optional(),
    /** Local time for the nightly prep reminder. Per profile. Omitted means no reminder. */
    reminder_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM").optional(),
    diet_flags: z.array(z.enum(["no_onion_garlic"])),
    liked_ingredients: z.array(slug),
    avoided_ingredients: z.array(slug),
  })
  .strict()
  .refine((p) => (p.protein_target_g === undefined) !== (p.protein_g_per_kg === undefined), {
    message: "set exactly one of protein_target_g or protein_g_per_kg",
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

/** End date is inclusive. The 7 and 14 day chips simply fill in the end date. */
export const PlanSetupSchema = z
  .object({
    person_ids: z.array(z.string().min(1)).min(1, "choose at least one person"),
    start_date: isoDate,
    end_date: isoDate,
    meal_types: z.array(z.enum(MEAL_SLOTS)).min(1, "choose at least one meal type"),
    cuisine_balance: z.number().min(0).max(1),
    max_active_min: z.number().positive().optional(),
    pinned_recipes: z.array(slug),
  })
  .strict()
  .superRefine((s, ctx) => {
    const days = planDays(s.start_date, s.end_date);
    if (days < 1) ctx.addIssue({ code: "custom", message: "end date must not be before start date", path: ["end_date"] });
    if (days > MAX_PLAN_DAYS) {
      ctx.addIssue({ code: "custom", message: `a plan can cover at most ${MAX_PLAN_DAYS} days`, path: ["end_date"] });
    }
  });

/** Inclusive day count between two ISO dates, computed in UTC so daylight saving cannot skew it. */
export function planDays(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

export type Person = z.infer<typeof PersonSchema>;
export type PlanSetup = z.infer<typeof PlanSetupSchema>;

export function displayName(i: { name: string; display_name?: string | undefined }): string {
  return i.display_name ?? i.name;
}
