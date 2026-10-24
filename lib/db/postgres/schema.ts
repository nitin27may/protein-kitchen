import { sql } from "drizzle-orm";
import { bigint, check, doublePrecision as real, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { bool, isoDate, isoTimestamp, json } from "./columns";

const id = () => integer("id").primaryKey().generatedByDefaultAsIdentity();

const authTime = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// Better Auth 1.7.12 generated fields; auth uses Date values, unlike the legacy ISO-string contract.
export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: bool("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [uniqueIndex("auth_users_normalized_email_uq").on(sql`lower(trim(${t.email}))`)]);

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: authTime("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
}, (t) => [index("auth_sessions_user_idx").on(t.userId)]);

export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: authTime("access_token_expires_at"),
  refreshTokenExpiresAt: authTime("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").$onUpdate(() => new Date()).notNull(),
}, (t) => [
  index("auth_accounts_user_idx").on(t.userId),
  uniqueIndex("auth_accounts_provider_account_uq").on(t.providerId, t.accountId),
]);

export const authVerifications = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: authTime("expires_at").notNull(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]);

export const authRateLimits = pgTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const householdBootstrap = pgTable("household_bootstrap", {
  id: integer("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => authUsers.id, { onDelete: "restrict" }),
  createdAt: authTime("created_at").defaultNow().notNull(),
}, (t) => [check("household_bootstrap_singleton", sql`${t.id} = 1`)]);

export const householdMembers = pgTable("household_members", {
  userId: text("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").defaultNow().notNull(),
}, (t) => [
  check("household_members_role_check", sql`${t.role} in ('owner', 'member')`),
  uniqueIndex("household_members_person_uq").on(t.personId),
]);

export const householdInvitations = pgTable("household_invitations", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => authUsers.id, { onDelete: "restrict" }),
  personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
  expiresAt: authTime("expires_at").notNull(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  acceptedAt: authTime("accepted_at"),
  acceptedByUserId: text("accepted_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  revokedAt: authTime("revoked_at"),
}, (t) => [
  check("household_invitations_email_check", sql`${t.email} = lower(trim(${t.email}))`),
  check("household_invitations_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  uniqueIndex("household_invitations_pending_email_uq").on(t.email)
    .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  uniqueIndex("household_invitations_pending_person_uq").on(t.personId)
    .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
]);

export const libraryState = pgTable("library_state", {
  key: text("key").primaryKey(),
  version: text("version").notNull(),
});

// Application schema. The frozen SQLite schema is retained for source import and parity checks.
export const ingredients = pgTable("ingredients", {
  id: id(),
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
}, (t) => [uniqueIndex("ingredients_slug_uq").on(t.slug), index("ingredients_aisle_idx").on(t.aisle)]);

export const ingredientMicros = pgTable("ingredient_micros", {
  ingredientId: integer("ingredient_id").primaryKey().references(() => ingredients.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  sourceId: text("source_id").notNull(),
  per100g: json<Record<string, number>>("per100g").notNull(),
  notReported: json<string[]>("not_reported").notNull(),
});

export const techniques = pgTable("techniques", {
  id: id(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  tags: json<string[]>("tags").notNull(),
}, (t) => [uniqueIndex("techniques_slug_uq").on(t.slug)]);

export const recipes = pgTable("recipes", {
  id: id(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["recipe", "component", "routine"] }).notNull(),
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
}, (t) => [uniqueIndex("recipes_slug_uq").on(t.slug), index("recipes_family_idx").on(t.family)]);

export const recipeItems = pgTable("recipe_items", {
  id: id(),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  ingredientId: integer("ingredient_id").references(() => ingredients.id, { onDelete: "no action" }),
  componentId: integer("component_id").references(() => recipes.id, { onDelete: "no action" }),
  grams: real("grams").notNull(),
  displayQty: real("display_qty"),
  displayUnit: text("display_unit"),
  optional: bool("optional").notNull(),
}, (t) => [index("recipe_items_recipe_idx").on(t.recipeId), index("recipe_items_ingredient_idx").on(t.ingredientId)]);

export const recipeSteps = pgTable("recipe_steps", {
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  stepNo: integer("step_no").notNull(),
  text: text("text").notNull(),
  techniqueId: integer("technique_id").references(() => techniques.id, { onDelete: "no action" }),
  timerSec: integer("timer_sec"),
}, (t) => [primaryKey({ columns: [t.recipeId, t.stepNo] })]);

export const recipeAdvancePrep = pgTable("recipe_advance_prep", {
  id: id(),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["soak", "sprout", "marinate", "set_dahi", "thaw", "overnight"] }).notNull(),
  ingredientId: integer("ingredient_id").references(() => ingredients.id, { onDelete: "no action" }),
  grams: real("grams"),
  leadHours: real("lead_hours").notNull(),
  instruction: text("instruction").notNull(),
});

export const recipeMacros = pgTable("recipe_macros", {
  recipeId: integer("recipe_id").primaryKey().references(() => recipes.id, { onDelete: "cascade" }),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  fatG: real("fat_g").notNull(),
  fibreG: real("fibre_g").notNull(),
  autoTags: json<string[]>("auto_tags").notNull(),
});

export const recipeAnchors = pgTable("recipe_anchors", {
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  ingredientId: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "no action" }),
  proteinG: real("protein_g").notNull(),
}, (t) => [primaryKey({ columns: [t.recipeId, t.ingredientId] }), index("recipe_anchors_ingredient_idx").on(t.ingredientId)]);

export const people = pgTable("people", {
  id: id(),
  name: text("name").notNull(),
  sex: text("sex", { enum: ["male", "female", "other"] }).notNull(),
  birthDate: isoDate("birth_date").notNull(),
  heightCm: real("height_cm").notNull(),
  weightKg: real("weight_kg").notNull(),
  activityLevel: text("activity_level", { enum: ["sedentary", "light", "moderate", "high"] }).notNull(),
  proteinTargetG: real("protein_target_g"),
  proteinGPerKg: real("protein_g_per_kg"),
  kcalTarget: real("kcal_target"),
  reminderTime: text("reminder_time"),
  dietFlags: json<string[]>("diet_flags").notNull(),
});

export const recipeFeedback = pgTable("recipe_feedback", {
  recipeId: integer("recipe_id").primaryKey().references(() => recipes.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["draft", "tested"] }).notNull().default("draft"),
  rating: integer("rating"),
  favourite: bool("favourite").notNull().default(false),
  banned: bool("banned").notNull().default(false),
  notes: text("notes"),
  testedAt: isoTimestamp("tested_at"),
  uid: text("uid"),
  createdAt: isoTimestamp("created_at"),
  updatedAt: isoTimestamp("updated_at"),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("recipe_feedback_uid_uq").on(t.uid)]);

export const personRecipeFeedback = pgTable("person_recipe_feedback", {
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  rating: integer("rating"),
  favourite: bool("favourite").notNull().default(false),
  uid: text("uid").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  primaryKey({ columns: [t.personId, t.recipeId] }),
  uniqueIndex("person_recipe_feedback_uid_uq").on(t.uid),
  check("person_recipe_feedback_rating_ck", sql`${t.rating} is null or ${t.rating} between 1 and 5`),
]);

export const preferences = pgTable("preferences", {
  id: id(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  ingredientId: integer("ingredient_id").references(() => ingredients.id, { onDelete: "no action" }),
  recipeId: integer("recipe_id").references(() => recipes.id, { onDelete: "no action" }),
  kind: text("kind", { enum: ["like", "avoid", "pin"] }).notNull(),
}, (t) => [index("preferences_person_idx").on(t.personId)]);

export const planSetups = pgTable("plan_setups", {
  id: id(),
  personIds: json<number[]>("person_ids").notNull(),
  startDate: isoDate("start_date").notNull(),
  endDate: isoDate("end_date").notNull(),
  mealTypes: json<string[]>("meal_types").notNull(),
  cuisineBalance: real("cuisine_balance").notNull(),
  maxActiveMin: integer("max_active_min"),
  healthFocus: json<{ nutrientDense: boolean; lowSugar: boolean; light: boolean }>("health_focus"),
  prepStyle: text("prep_style", { enum: ["variety", "leftovers", "batch"] }),
  shoppingDay: integer("shopping_day"),
  prepDay: integer("prep_day"),
  createdAt: isoTimestamp("created_at").notNull(),
});

export const plans = pgTable("plans", {
  id: id(),
  setupId: integer("setup_id").notNull().references(() => planSetups.id, { onDelete: "no action" }),
  seed: integer("seed").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
});

export const planSlots = pgTable("plan_slots", {
  id: id(),
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  date: isoDate("date").notNull(),
  slot: text("slot", { enum: ["breakfast", "lunch", "dinner", "snack", "shake"] }).notNull(),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "no action" }),
  locked: bool("locked").notNull().default(false),
  isLeftover: bool("is_leftover").notNull().default(false),
}, (t) => [index("plan_slots_plan_idx").on(t.planId, t.date)]);

export const planSlotPortions = pgTable("plan_slot_portions", {
  planSlotId: integer("plan_slot_id").notNull().references(() => planSlots.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "no action" }),
  servings: real("servings").notNull(),
}, (t) => [primaryKey({ columns: [t.planSlotId, t.personId] })]);

export const habits = pgTable("habits", {
  id: id(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  evidenceGrade: text("evidence_grade").notNull(),
  evidenceNote: text("evidence_note").notNull(),
  sourceUrl: text("source_url"),
  caution: text("caution"),
  defaultOn: bool("default_on").notNull(),
});

export const habitLog = pgTable("habit_log", {
  date: isoDate("date").notNull(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").notNull().references(() => habits.id, { onDelete: "no action" }),
  done: bool("done").notNull(),
}, (t) => [primaryKey({ columns: [t.date, t.personId, t.habitId] })]);

export const prepTaskState = pgTable("prep_task_state", {
  date: isoDate("date").notNull(),
  taskKey: text("task_key").notNull(),
  done: bool("done").notNull(),
}, (t) => [primaryKey({ columns: [t.date, t.taskKey] })]);

export const groceryState = pgTable("grocery_state", {
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  ingredientId: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "no action" }),
  checked: bool("checked").notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.ingredientId] })]);

export const planPartState = pgTable("plan_part_state", {
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  componentSlug: text("component_slug").notNull(),
  mode: text("mode").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.componentSlug] }), check("plan_part_state_mode_ck", sql`${t.mode} in ('make', 'buy', 'have')`)]);

export const planProgress = pgTable("plan_progress", {
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  step: text("step").notNull(),
  doneAt: isoTimestamp("done_at").notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.step] }), check("plan_progress_step_ck", sql`${t.step} in ('reviewed', 'shopping', 'prep')`)]);

export const groceryManual = pgTable("grocery_manual", {
  id: id(),
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  checked: bool("checked").notNull(),
});

export const pantry = pgTable("pantry", {
  ingredientId: integer("ingredient_id").primaryKey().references(() => ingredients.id, { onDelete: "no action" }),
  have: bool("have").notNull(),
  alwaysStock: bool("always_stock").notNull(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: id(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
}, (t) => [uniqueIndex("push_endpoint_uq").on(t.endpoint), index("push_person_idx").on(t.personId)]);

export const reminderLog = pgTable("reminder_log", {
  date: isoDate("date").notNull(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  sentAt: isoTimestamp("sent_at").notNull(),
}, (t) => [primaryKey({ columns: [t.date, t.personId] })]);

export const savedViews = pgTable("saved_views", {
  id: id(),
  list: text("list").notNull(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  isDefault: bool("is_default").notNull().default(false),
  uid: text("uid"),
  createdAt: isoTimestamp("created_at"),
  updatedAt: isoTimestamp("updated_at"),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [index("saved_views_list_idx").on(t.list), uniqueIndex("saved_views_uid_uq").on(t.uid)]);

export const syncState = pgTable("sync_state", {
  dataClass: text("data_class").primaryKey(),
  changedAt: isoTimestamp("changed_at").notNull(),
  exportedAt: isoTimestamp("exported_at"),
});

export const recipeLinks = pgTable("recipe_links", {
  id: id(),
  uid: text("uid").notNull(),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  partSlug: text("part_slug"),
  stepNo: integer("step_no"),
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  source: text("source"),
  startSec: integer("start_sec"),
  position: integer("position").notNull().default(0),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  index("recipe_links_recipe_idx").on(t.recipeId),
  uniqueIndex("recipe_links_uid_uq").on(t.uid),
  check("recipe_links_kind_ck", sql`${t.kind} in ('recipe', 'video', 'article')`),
]);

export const photos = pgTable("photos", {
  id: id(),
  uid: text("uid").notNull(),
  recipeId: integer("recipe_id").references(() => recipes.id, { onDelete: "cascade" }),
  ingredientSlug: text("ingredient_slug"),
  origin: text("origin").notNull(),
  candidateKey: text("candidate_key"),
  sha256: text("sha256").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  isCover: bool("is_cover").notNull().default(false),
  position: integer("position").notNull().default(0),
  title: text("title"),
  author: text("author"),
  licence: text("licence"),
  licenceUrl: text("licence_url"),
  sourceUrl: text("source_url"),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  index("photos_recipe_idx").on(t.recipeId),
  index("photos_ingredient_idx").on(t.ingredientSlug),
  uniqueIndex("photos_uid_uq").on(t.uid),
  check("photos_origin_ck", sql`${t.origin} in ('upload', 'commons', 'openverse')`),
  check("photos_subject_ck", sql`(${t.recipeId} is not null) <> (${t.ingredientSlug} is not null)`),
]);

export const photoDecisions = pgTable("photo_decisions", {
  id: id(),
  uid: text("uid").notNull(),
  candidateKey: text("candidate_key").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectSlug: text("subject_slug").notNull(),
  decision: text("decision").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("photo_decisions_uid_uq").on(t.uid),
  uniqueIndex("photo_decisions_candidate_uq").on(t.subjectKind, t.subjectSlug, t.candidateKey),
  check("photo_decisions_kind_ck", sql`${t.subjectKind} in ('recipe', 'ingredient')`),
  check("photo_decisions_decision_ck", sql`${t.decision} in ('approved', 'rejected')`),
]);

export const personRoutines = pgTable("person_routines", {
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").notNull().references(() => habits.id, { onDelete: "no action" }),
  days: json<number[]>("days").notNull(),
  timeOfDay: text("time_of_day").notNull(),
  servings: real("servings").notNull(),
  active: bool("active").notNull(),
  uid: text("uid"),
  createdAt: isoTimestamp("created_at"),
  updatedAt: isoTimestamp("updated_at"),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [primaryKey({ columns: [t.personId, t.habitId] }), uniqueIndex("person_routines_uid_uq").on(t.uid)]);

export const planRoutines = pgTable("plan_routines", {
  planId: integer("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").notNull().references(() => habits.id, { onDelete: "no action" }),
  days: json<number[]>("days").notNull(),
  timeOfDay: text("time_of_day").notNull(),
  servings: real("servings").notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.personId, t.habitId] })]);
