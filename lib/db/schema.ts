import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, isoTimestamp, json } from "./columns";

// ---- Content tables: rebuilt from /data on every seed. Never hold user state here. ----

export const ingredients = sqliteTable(
  "ingredients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    aliases: json<string[]>("aliases").notNull(),
    state: text("state", { enum: ["dry", "cooked", "raw", "ready"] }).notNull(),
    cookedYield: real("cooked_yield"),
    kcal: real("kcal").notNull(),
    proteinG: real("protein_g").notNull(),
    carbsG: real("carbs_g").notNull(),
    fatG: real("fat_g").notNull(),
    fibreG: real("fibre_g").notNull(),
    source: text("source", { enum: ["CNF", "USDA", "IFCT"] }).notNull(),
    sourceId: text("source_id").notNull(),
    aisle: text("aisle").notNull(),
    packSizeG: real("pack_size_g"),
    whereToBuy: json<string[]>("where_to_buy").notNull(),
    isPantryStaple: bool("is_pantry_staple").notNull(),
    containsOnionGarlic: bool("contains_onion_garlic").notNull(),
    isDairy: bool("is_dairy").notNull(),
    image: text("image"),
    imageCredit: text("image_credit"),
  },
  (t) => [uniqueIndex("ingredients_slug_uq").on(t.slug), index("ingredients_aisle_idx").on(t.aisle)],
);

export const ingredientMicros = sqliteTable("ingredient_micros", {
  ingredientId: integer("ingredient_id")
    .primaryKey()
    .references(() => ingredients.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  sourceId: text("source_id").notNull(),
  per100g: json<Record<string, number>>("per100g").notNull(),
  notReported: json<string[]>("not_reported").notNull(),
});

export const techniques = sqliteTable(
  "techniques",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    tags: json<string[]>("tags").notNull(),
  },
  (t) => [uniqueIndex("techniques_slug_uq").on(t.slug)],
);

export const recipes = sqliteTable(
  "recipes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["recipe", "component"] }).notNull(),
    family: text("family").notNull(),
    mealSlots: json<string[]>("meal_slots").notNull(),
    cuisine: text("cuisine").notNull(),
    isIndian: bool("is_indian").notNull(),
    servings: real("servings").notNull(),
    prepMin: integer("prep_min").notNull(),
    activeMin: integer("active_min").notNull(),
    totalMin: integer("total_min").notNull(),
    equipment: json<string[]>("equipment").notNull(),
    tags: json<string[]>("tags").notNull(),
    fridgeDays: integer("fridge_days").notNull(),
    image: text("image"),
    imageCredit: text("image_credit"),
  },
  (t) => [uniqueIndex("recipes_slug_uq").on(t.slug), index("recipes_family_idx").on(t.family)],
);

export const recipeItems = sqliteTable(
  "recipe_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    ingredientId: integer("ingredient_id").references(() => ingredients.id),
    componentId: integer("component_id").references(() => recipes.id),
    grams: real("grams").notNull(),
    displayQty: real("display_qty"),
    displayUnit: text("display_unit"),
    optional: bool("optional").notNull(),
  },
  (t) => [index("recipe_items_recipe_idx").on(t.recipeId), index("recipe_items_ingredient_idx").on(t.ingredientId)],
);

export const recipeSteps = sqliteTable(
  "recipe_steps",
  {
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    stepNo: integer("step_no").notNull(),
    text: text("text").notNull(),
    techniqueId: integer("technique_id").references(() => techniques.id),
    timerSec: integer("timer_sec"),
  },
  (t) => [primaryKey({ columns: [t.recipeId, t.stepNo] })],
);

export const recipeAdvancePrep = sqliteTable("recipe_advance_prep", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["soak", "sprout", "marinate", "set_dahi", "thaw", "overnight"] }).notNull(),
  ingredientId: integer("ingredient_id").references(() => ingredients.id),
  grams: real("grams"),
  leadHours: real("lead_hours").notNull(),
  instruction: text("instruction").notNull(),
});

/** Computed at seed time. Per serving. Replaces the SQL view in the plan because components nest. */
export const recipeMacros = sqliteTable("recipe_macros", {
  recipeId: integer("recipe_id")
    .primaryKey()
    .references(() => recipes.id, { onDelete: "cascade" }),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  fatG: real("fat_g").notNull(),
  fibreG: real("fibre_g").notNull(),
  autoTags: json<string[]>("auto_tags").notNull(),
});

export const recipeAnchors = sqliteTable(
  "recipe_anchors",
  {
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    proteinG: real("protein_g").notNull(),
  },
  (t) => [primaryKey({ columns: [t.recipeId, t.ingredientId] }), index("recipe_anchors_ingredient_idx").on(t.ingredientId)],
);

// ---- User state: written by the app only. Seeding must never touch these. ----

/** Human-owned fields from CLAUDE.md rule 6. Kept apart so reseeding cannot reset them. */
export const recipeFeedback = sqliteTable("recipe_feedback", {
  recipeId: integer("recipe_id")
    .primaryKey()
    .references(() => recipes.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["draft", "tested"] }).notNull().default("draft"),
  rating: integer("rating"),
  favourite: bool("favourite").notNull().default(false),
  banned: bool("banned").notNull().default(false),
  notes: text("notes"),
  testedAt: text("tested_at"),
  // Human-owned row bookkeeping (see CLAUDE.md "Human-owned data"). Nullable so existing rows migrate;
  // lib/human fills them on first write or export. Exports are keyed by recipe slug, never by id.
  uid: text("uid"),
  createdAt: isoTimestamp("created_at"),
  updatedAt: isoTimestamp("updated_at"),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("recipe_feedback_uid_uq").on(t.uid)]);

export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sex: text("sex", { enum: ["male", "female", "other"] }).notNull(),
  birthDate: text("birth_date").notNull(),
  heightCm: real("height_cm").notNull(),
  weightKg: real("weight_kg").notNull(),
  activityLevel: text("activity_level", { enum: ["sedentary", "light", "moderate", "high"] }).notNull(),
  proteinTargetG: real("protein_target_g"),
  proteinGPerKg: real("protein_g_per_kg"),
  kcalTarget: real("kcal_target"),
  reminderTime: text("reminder_time"),
  dietFlags: json<string[]>("diet_flags").notNull(),
});

export const preferences = sqliteTable(
  "preferences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id").references(() => ingredients.id),
    recipeId: integer("recipe_id").references(() => recipes.id),
    kind: text("kind", { enum: ["like", "avoid", "pin"] }).notNull(),
  },
  (t) => [index("preferences_person_idx").on(t.personId)],
);

export const planSetups = sqliteTable("plan_setups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personIds: json<number[]>("person_ids").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  mealTypes: json<string[]>("meal_types").notNull(),
  cuisineBalance: real("cuisine_balance").notNull(),
  maxActiveMin: integer("max_active_min"),
  /** Nudges toward nutrient-dense, low-sugar and lighter meals. Null on plans made before this existed. */
  healthFocus: json<{ nutrientDense: boolean; lowSugar: boolean; light: boolean }>("health_focus"),
  /** variety, leftovers or batch. Null on plans made before this existed, which behave as variety. */
  prepStyle: text("prep_style", { enum: ["variety", "leftovers", "batch"] }),
  createdAt: text("created_at").notNull(),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  setupId: integer("setup_id")
    .notNull()
    .references(() => planSetups.id),
  seed: integer("seed").notNull(),
  createdAt: text("created_at").notNull(),
});

export const planSlots = sqliteTable(
  "plan_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: integer("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    slot: text("slot", { enum: ["breakfast", "lunch", "dinner", "snack", "shake"] }).notNull(),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id),
    locked: bool("locked").notNull().default(false),
    isLeftover: bool("is_leftover").notNull().default(false),
  },
  (t) => [index("plan_slots_plan_idx").on(t.planId, t.date)],
);

/** One cooked recipe, a portion per person. */
export const planSlotPortions = sqliteTable(
  "plan_slot_portions",
  {
    planSlotId: integer("plan_slot_id")
      .notNull()
      .references(() => planSlots.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id),
    servings: real("servings").notNull(),
  },
  (t) => [primaryKey({ columns: [t.planSlotId, t.personId] })],
);

export const habits = sqliteTable("habits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  evidenceGrade: text("evidence_grade").notNull(),
  evidenceNote: text("evidence_note").notNull(),
  sourceUrl: text("source_url"),
  caution: text("caution"),
  defaultOn: bool("default_on").notNull(),
});

export const habitLog = sqliteTable(
  "habit_log",
  {
    date: text("date").notNull(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habits.id),
    done: bool("done").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.personId, t.habitId] })],
);

export const prepTaskState = sqliteTable(
  "prep_task_state",
  {
    date: text("date").notNull(),
    taskKey: text("task_key").notNull(),
    done: bool("done").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.taskKey] })],
);

export const groceryState = sqliteTable(
  "grocery_state",
  {
    planId: integer("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    checked: bool("checked").notNull(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.ingredientId] })],
);

export const groceryManual = sqliteTable("grocery_manual", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id")
    .notNull()
    .references(() => plans.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  checked: bool("checked").notNull(),
});

export const pantry = sqliteTable("pantry", {
  ingredientId: integer("ingredient_id")
    .primaryKey()
    .references(() => ingredients.id),
  have: bool("have").notNull(),
  alwaysStock: bool("always_stock").notNull(),
});

// ---- Reminders ----

/** One row per browser or phone that turned reminders on for a person. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("push_endpoint_uq").on(t.endpoint), index("push_person_idx").on(t.personId)],
);

/** Makes sure a person gets at most one reminder a day, even across restarts. */
export const reminderLog = sqliteTable(
  "reminder_log",
  {
    date: text("date").notNull(),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    sentAt: text("sent_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.personId] })],
);

// ---- Saved list views ----

/**
 * A saved filter query for a list ("recipes", "ingredients"). The default view for a list opens when its URL carries no
 * filters. Plain text and integer columns only, so the table moves to Postgres unchanged.
 */
export const savedViews = sqliteTable(
  "saved_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    list: text("list").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull(),
    isDefault: bool("is_default").notNull().default(false),
    uid: text("uid"),
    createdAt: isoTimestamp("created_at"),
    updatedAt: isoTimestamp("updated_at"),
    createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
  },
  (t) => [index("saved_views_list_idx").on(t.list), uniqueIndex("saved_views_uid_uq").on(t.uid)],
);

/**
 * Which human-owned data classes changed since they were last exported. lib/human writes this in the same
 * transaction as every human-owned write; the export job reads it and stamps `exported_at`.
 */
export const syncState = sqliteTable("sync_state", {
  dataClass: text("data_class").primaryKey(),
  changedAt: isoTimestamp("changed_at").notNull(),
  exportedAt: isoTimestamp("exported_at"),
});
