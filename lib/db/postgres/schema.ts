import { sql } from "drizzle-orm";
import { bigint, check, doublePrecision as real, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
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
  activeHouseholdId: text("active_household_id").references(() => households.id, { onDelete: "set null" }),
  householdSelectionVersion: integer("household_selection_version").default(0).notNull(),
  expiresAt: authTime("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
}, (t) => [
  index("auth_sessions_user_idx").on(t.userId),
  check("auth_sessions_selection_version_check", sql`${t.householdSelectionVersion} >= 0`),
]);

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
  ownerUserId: text("owner_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  createdAt: authTime("created_at").defaultNow().notNull(),
}, (t) => [check("household_bootstrap_singleton", sql`${t.id} = 1`)]);

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").defaultNow().notNull(),
}, (t) => [check("households_name_check", sql`length(trim(${t.name})) between 1 and 100`)]);

// Null ownership is quarantined operator staging, never adopted by self-service household creation.
const householdId = () => text("household_id").references(() => households.id, { onDelete: "restrict" });

export const householdMembers = pgTable("household_members", {
  householdId: householdId(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
  createdAt: authTime("created_at").defaultNow().notNull(),
  updatedAt: authTime("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("household_members_household_user_uq").on(t.householdId, t.userId).nullsNotDistinct(),
  index("household_members_user_idx").on(t.userId),
  index("household_members_household_idx").on(t.householdId),
  check("household_members_role_check", sql`${t.role} in ('owner', 'member')`),
  uniqueIndex("household_members_person_uq").on(t.personId),
  foreignKey({ name: "household_members_profile_household_fk", columns: [t.householdId, t.personId], foreignColumns: [people.householdId, people.id] }),
]);

export const householdInvitations = pgTable("household_invitations", {
  householdId: householdId(),
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").unique(),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => authUsers.id, { onDelete: "restrict" }),
  personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
  displayName: text("display_name"),
  relationship: text("relationship"),
  expiresAt: authTime("expires_at").notNull(),
  createdAt: authTime("created_at").defaultNow().notNull(),
  acceptedAt: authTime("accepted_at"),
  acceptedByUserId: text("accepted_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  declinedAt: authTime("declined_at"),
  revokedAt: authTime("revoked_at"),
}, (t) => [
  index("household_invitations_household_idx").on(t.householdId),
  foreignKey({ name: "household_invitations_profile_household_fk", columns: [t.householdId, t.personId], foreignColumns: [people.householdId, people.id] }),
  check("household_invitations_email_check", sql`${t.email} = lower(trim(${t.email}))`),
  check("household_invitations_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  check("household_invitations_relationship_check", sql`${t.relationship} is null or length(trim(${t.relationship})) between 1 and 40`),
  uniqueIndex("household_invitations_pending_email_uq").on(t.householdId, t.email)
    .where(sql`${t.householdId} is not null and ${t.acceptedAt} is null and ${t.declinedAt} is null and ${t.revokedAt} is null`),
  uniqueIndex("household_invitations_pending_person_uq").on(t.personId)
    .where(sql`${t.acceptedAt} is null and ${t.declinedAt} is null and ${t.revokedAt} is null`),
]);

export const libraryState = pgTable("library_state", {
  key: text("key").primaryKey(),
  version: text("version").notNull(),
});

/** Append-only history of seeded library fingerprints; lets a still-serving build or a rollback keep starting. */
export const libraryVersions = pgTable("library_versions", {
  version: text("version").primaryKey(),
  seededAt: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Auth mail ledger: an HMAC of the normalised recipient, never the address. Rows older than 2 days are pruned. */
export const mailSends = pgTable("mail_sends", {
  id: id(),
  recipientHash: text("recipient_hash").notNull(),
  purpose: text("purpose").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("mail_sends_recipient_created_idx").on(t.recipientHash, t.createdAt)]);

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
  householdId: householdId(),
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
  reminderTimezone: text("reminder_timezone"),
  dietFlags: json<string[]>("diet_flags").notNull(),
}, (t) => [
  index("people_household_idx").on(t.householdId),
  uniqueIndex("people_household_id_uq").on(t.householdId, t.id),
]);

export const recipeFeedback = pgTable("recipe_feedback", {
  householdId: householdId(),
  recipeId: integer("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
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
}, (t) => [
  unique("recipe_feedback_household_recipe_uq").on(t.householdId, t.recipeId).nullsNotDistinct(),
  uniqueIndex("recipe_feedback_uid_uq").on(t.uid), index("recipe_feedback_household_idx").on(t.householdId),
]);

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
  householdId: householdId(),
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
}, (t) => [
  index("plan_setups_household_idx").on(t.householdId),
  uniqueIndex("plan_setups_household_id_uq").on(t.householdId, t.id),
]);

export const plans = pgTable("plans", {
  householdId: householdId(),
  id: id(),
  setupId: integer("setup_id").notNull().references(() => planSetups.id, { onDelete: "no action" }),
  seed: integer("seed").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
}, (t) => [
  index("plans_household_idx").on(t.householdId),
  foreignKey({ name: "plans_setup_household_fk", columns: [t.householdId, t.setupId], foreignColumns: [planSetups.householdId, planSetups.id] }),
]);

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
  householdId: householdId(),
  date: isoDate("date").notNull(),
  taskKey: text("task_key").notNull(),
  done: bool("done").notNull(),
}, (t) => [
  unique("prep_task_state_household_task_uq").on(t.householdId, t.date, t.taskKey).nullsNotDistinct(),
  index("prep_task_state_household_idx").on(t.householdId),
]);

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
  householdId: householdId(),
  ingredientId: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "no action" }),
  have: bool("have").notNull(),
  alwaysStock: bool("always_stock").notNull(),
}, (t) => [
  unique("pantry_household_ingredient_uq").on(t.householdId, t.ingredientId).nullsNotDistinct(),
  index("pantry_household_idx").on(t.householdId),
]);

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

export const reminderBatches = pgTable("reminder_batches", {
  householdId: householdId(),
  id: text("id").primaryKey(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  date: isoDate("date").notNull(),
  payload: json<{ title: string; body: string; url: string }>("payload").notNull(),
  expiresAt: isoTimestamp("expires_at").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
}, (t) => [uniqueIndex("reminder_batch_day_uq").on(t.personId, t.date)]);

export const reminderDeliveries = pgTable("reminder_deliveries", {
  batchId: text("batch_id").notNull().references(() => reminderBatches.id, { onDelete: "cascade" }),
  subscriptionId: integer("subscription_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status", { enum: ["pending", "sending", "accepted", "gone", "cancelled", "retry", "ambiguous"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  attemptToken: text("attempt_token"),
  attemptedAt: isoTimestamp("attempted_at"),
  retryAt: isoTimestamp("retry_at"),
  updatedAt: isoTimestamp("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.batchId, t.subscriptionId] }),
  check("reminder_delivery_status_valid", sql`${t.status} in ('pending', 'sending', 'accepted', 'gone', 'cancelled', 'retry', 'ambiguous')`),
  check("reminder_delivery_attempts_valid", sql`${t.attempts} >= 0 and ${t.attempts} <= 3`),
]);

export const savedViews = pgTable("saved_views", {
  householdId: householdId(),
  id: id(),
  list: text("list").notNull(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  isDefault: bool("is_default").notNull().default(false),
  uid: text("uid"),
  createdAt: isoTimestamp("created_at"),
  updatedAt: isoTimestamp("updated_at"),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [index("saved_views_list_idx").on(t.list), uniqueIndex("saved_views_uid_uq").on(t.uid), index("saved_views_household_idx").on(t.householdId)]);

export const syncState = pgTable("sync_state", {
  householdId: householdId(),
  dataClass: text("data_class").notNull(),
  changedAt: isoTimestamp("changed_at").notNull(),
  exportedAt: isoTimestamp("exported_at"),
  revision: integer("revision").notNull().default(1),
  exportedRevision: integer("exported_revision").notNull().default(0),
}, (t) => [
  unique("sync_state_household_class_uq").on(t.householdId, t.dataClass).nullsNotDistinct(),
  check("sync_state_revision_valid", sql`${t.revision} > 0 and ${t.exportedRevision} >= 0 and ${t.exportedRevision} <= ${t.revision}`),
  index("sync_state_household_idx").on(t.householdId),
]);

// Operational coordination only: never part of human-state exporters.
export const stateSyncJobs = pgTable("state_sync_jobs", {
  householdId: householdId(),
  targetKey: text("target_key").primaryKey(),
  status: text("status").$type<"idle" | "running" | "success" | "error" | "conflict">().notNull().default("idle"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: isoTimestamp("lease_expires_at"),
  checkpointCommit: text("checkpoint_commit"),
  acknowledged: json<Record<string, number>>("acknowledged").notNull().default({}),
  pending: json<{ revisions: Record<string, number>; files: Record<string, string> }>("pending"),
  lastAttemptAt: isoTimestamp("last_attempt_at"),
  lastSuccessAt: isoTimestamp("last_success_at"),
  errorCode: text("error_code"),
}, (t) => [check("state_sync_job_status_valid", sql`${t.status} in ('idle', 'running', 'success', 'error', 'conflict')`), index("state_sync_jobs_household_idx").on(t.householdId)]);

export const stateSyncRequests = pgTable("state_sync_requests", {
  id: text("id").primaryKey(),
  targetKey: text("target_key").notNull().references(() => stateSyncJobs.targetKey, { onDelete: "cascade" }),
  status: text("status").$type<"running" | "success" | "error" | "conflict">().notNull(),
  startedAt: isoTimestamp("started_at").notNull(),
  completedAt: isoTimestamp("completed_at"),
}, (t) => [check("state_sync_request_status_valid", sql`${t.status} in ('running', 'success', 'error', 'conflict')`)]);

export const recipeLinks = pgTable("recipe_links", {
  householdId: householdId(),
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
  index("recipe_links_household_idx").on(t.householdId),
  index("recipe_links_recipe_idx").on(t.recipeId),
  uniqueIndex("recipe_links_uid_uq").on(t.uid),
  check("recipe_links_kind_ck", sql`${t.kind} in ('recipe', 'video', 'article')`),
]);

export const photos = pgTable("photos", {
  householdId: householdId(),
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
  index("photos_household_idx").on(t.householdId),
  index("photos_recipe_idx").on(t.recipeId),
  index("photos_ingredient_idx").on(t.ingredientSlug),
  uniqueIndex("photos_uid_uq").on(t.uid),
  check("photos_origin_ck", sql`${t.origin} in ('upload', 'commons', 'openverse')`),
  check("photos_subject_ck", sql`(${t.recipeId} is not null) <> (${t.ingredientSlug} is not null)`),
]);

export const photoDecisions = pgTable("photo_decisions", {
  householdId: householdId(),
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
  index("photo_decisions_household_idx").on(t.householdId),
  uniqueIndex("photo_decisions_uid_uq").on(t.uid),
  unique("photo_decisions_household_candidate_uq").on(t.householdId, t.subjectKind, t.subjectSlug, t.candidateKey).nullsNotDistinct(),
  check("photo_decisions_kind_ck", sql`${t.subjectKind} in ('recipe', 'ingredient')`),
  check("photo_decisions_decision_ck", sql`${t.decision} in ('approved', 'rejected')`),
]);

/**
 * Library-level photo approvals: stored once, no household, shown to everyone. A NULL household_id in `photos` means
 * quarantined operator staging, so these never share rows with it. Written only by lib/human/library-photos.ts.
 */
export const libraryPhotos = pgTable("library_photos", {
  id: id(),
  uid: text("uid").notNull(),
  recipeId: integer("recipe_id").references(() => recipes.id, { onDelete: "cascade" }),
  ingredientSlug: text("ingredient_slug"),
  origin: text("origin").notNull(),
  candidateKey: text("candidate_key").notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  isCover: bool("is_cover").notNull().default(false),
  position: integer("position").notNull().default(0),
  title: text("title").notNull(),
  author: text("author").notNull(),
  licence: text("licence").notNull(),
  sourceUrl: text("source_url").notNull(),
  licenceUrl: text("licence_url"),
  licenceCheckedAt: isoTimestamp("licence_checked_at"),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("library_photos_uid_uq").on(t.uid),
  index("library_photos_recipe_idx").on(t.recipeId),
  index("library_photos_ingredient_idx").on(t.ingredientSlug),
  uniqueIndex("library_photos_recipe_candidate_uq").on(t.recipeId, t.candidateKey).where(sql`${t.recipeId} is not null`),
  uniqueIndex("library_photos_ingredient_candidate_uq").on(t.ingredientSlug, t.candidateKey).where(sql`${t.ingredientSlug} is not null`),
  uniqueIndex("library_photos_recipe_cover_uq").on(t.recipeId).where(sql`${t.isCover}`),
  uniqueIndex("library_photos_ingredient_cover_uq").on(t.ingredientSlug).where(sql`${t.isCover} and ${t.recipeId} is null`),
  check("library_photos_origin_ck", sql`${t.origin} in ('commons', 'openverse')`),
  check("library_photos_subject_ck", sql`(${t.recipeId} is not null) <> (${t.ingredientSlug} is not null)`),
]);

export const libraryPhotoDecisions = pgTable("library_photo_decisions", {
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
  uniqueIndex("library_photo_decisions_uid_uq").on(t.uid),
  uniqueIndex("library_photo_decisions_candidate_uq").on(t.subjectKind, t.subjectSlug, t.candidateKey),
  index("library_photo_decisions_person_idx").on(t.createdByPersonId, t.createdAt),
  check("library_photo_decisions_kind_ck", sql`${t.subjectKind} in ('recipe', 'ingredient')`),
  check("library_photo_decisions_decision_ck", sql`${t.decision} in ('approved', 'rejected')`),
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

const FOOD_STATES = ["dry", "cooked", "raw", "ready"] as const;
const FOOD_SOURCES = ["LABEL", "OFF", "MANUAL"] as const;
const FOOD_LABEL_BASES = ["per_serving", "per_100g", "per_100ml"] as const;
const FOOD_LOG_SLOTS = ["breakfast", "lunch", "dinner", "snack", "shake"] as const;
const FOOD_LOG_KINDS = ["planned", "skipped", "swap", "extra"] as const;
const ownedHousehold = () => text("household_id").notNull().references(() => households.id, { onDelete: "restrict" });

/**
 * A household's master list of packaged foods, added from a label. Human-owned: written only by
 * lib/human/household-foods.ts. Nutrients are per 100 g exactly as confirmed; fibre NULL means "not reported".
 */
export const householdFoods = pgTable("household_foods", {
  householdId: ownedHousehold(),
  id: id(),
  uid: text("uid").notNull(),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  brand: text("brand"),
  barcode: text("barcode"),
  state: text("state", { enum: FOOD_STATES }).notNull().default("ready"),
  aisle: text("aisle").notNull().default("packaged"),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  fatG: real("fat_g").notNull(),
  fibreG: real("fibre_g"),
  per100gMicros: json<Record<string, number>>("per100g_micros").notNull().default({}),
  notReported: json<string[]>("not_reported").notNull().default([]),
  servingLabel: text("serving_label"),
  servingG: real("serving_g"),
  servingMl: real("serving_ml"),
  densityGPerMl: real("density_g_per_ml"),
  pieceLabel: text("piece_label"),
  pieceG: real("piece_g"),
  labelBasis: text("label_basis", { enum: FOOD_LABEL_BASES }).notNull(),
  labelValues: json<Record<string, unknown>>("label_values").notNull().default({}),
  source: text("source", { enum: FOOD_SOURCES }).notNull(),
  sourceId: text("source_id"),
  fieldOrigins: json<Record<string, string>>("field_origins").notNull().default({}),
  confirmedAt: isoTimestamp("confirmed_at").notNull(),
  confirmedByPersonId: integer("confirmed_by_person_id").references(() => people.id, { onDelete: "set null" }),
  labelPhotoUid: text("label_photo_uid"),
  labelPhotoSha256: text("label_photo_sha256"),
  ingredientsText: text("ingredients_text"),
  isDairy: bool("is_dairy").notNull().default(false),
  containsOnionGarlic: bool("contains_onion_garlic").notNull().default(false),
  dietFlagsFound: json<string[]>("diet_flags_found").notNull().default([]),
  dietCheckedAt: isoTimestamp("diet_checked_at"),
  archivedAt: isoTimestamp("archived_at"),
}, (t) => [
  uniqueIndex("household_foods_uid_uq").on(t.uid),
  index("household_foods_household_idx").on(t.householdId),
  // Lets food_log point at (household, food) so a log entry can never name another household's food.
  uniqueIndex("household_foods_household_id_uq").on(t.householdId, t.id),
  uniqueIndex("household_foods_barcode_uq").on(t.householdId, t.barcode).where(sql`${t.barcode} is not null`),
  check("household_foods_nutrients_ck", sql`${t.kcal} >= 0 and ${t.proteinG} >= 0 and ${t.carbsG} >= 0 and ${t.fatG} >= 0 and (${t.fibreG} is null or ${t.fibreG} >= 0)`),
  check("household_foods_macro_mass_ck", sql`${t.proteinG} + ${t.carbsG} + ${t.fatG} <= 105`),
  check("household_foods_amounts_ck", sql`(${t.servingG} is null or ${t.servingG} > 0) and (${t.servingMl} is null or ${t.servingMl} > 0) and (${t.densityGPerMl} is null or ${t.densityGPerMl} > 0) and (${t.pieceG} is null or ${t.pieceG} > 0)`),
  check("household_foods_barcode_ck", sql`${t.barcode} is null or ${t.barcode} ~ '^[0-9]{8,14}$'`),
  check("household_foods_state_ck", sql`${t.state} in ('dry', 'cooked', 'raw', 'ready')`),
  check("household_foods_source_ck", sql`${t.source} in ('LABEL', 'OFF', 'MANUAL')`),
  check("household_foods_basis_ck", sql`${t.labelBasis} in ('per_serving', 'per_100g', 'per_100ml')`),
  check("household_foods_label_photo_ck", sql`(${t.labelPhotoUid} is null) = (${t.labelPhotoSha256} is null)`),
]);

/**
 * What a person ate. Human-owned: written only by lib/human/food-log.ts. Entries store amounts, never macros
 * (golden rule 1); nutrition is computed from the recipe, ingredient or household food at read time. A `skipped`
 * entry names the skipped meal in its item columns and is never counted as eaten.
 */
export const foodLog = pgTable("food_log", {
  householdId: ownedHousehold(),
  id: id(),
  uid: text("uid").notNull(),
  personId: integer("person_id").notNull(),
  date: isoDate("date").notNull(),
  slot: text("slot", { enum: FOOD_LOG_SLOTS }).notNull(),
  kind: text("kind", { enum: FOOD_LOG_KINDS }).notNull(),
  recipeSlug: text("recipe_slug"),
  servings: real("servings"),
  ingredientSlug: text("ingredient_slug"),
  householdFoodId: integer("household_food_id"),
  grams: real("grams"),
  displayQty: real("display_qty"),
  displayUnit: text("display_unit"),
  planId: integer("plan_id").references(() => plans.id, { onDelete: "set null" }),
  plannedRecipeSlug: text("planned_recipe_slug"),
  plannedServings: real("planned_servings"),
  note: text("note"),
  createdAt: isoTimestamp("created_at").notNull(),
  updatedAt: isoTimestamp("updated_at").notNull(),
  createdByPersonId: integer("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("food_log_uid_uq").on(t.uid),
  index("food_log_person_date_idx").on(t.personId, t.date),
  index("food_log_household_idx").on(t.householdId),
  index("food_log_food_idx").on(t.householdFoodId),
  index("food_log_plan_idx").on(t.planId),
  foreignKey({ name: "food_log_person_household_fk", columns: [t.householdId, t.personId], foreignColumns: [people.householdId, people.id] }).onDelete("cascade"),
  foreignKey({ name: "food_log_food_household_fk", columns: [t.householdId, t.householdFoodId], foreignColumns: [householdFoods.householdId, householdFoods.id] }),
  check("food_log_slot_ck", sql`${t.slot} in ('breakfast', 'lunch', 'dinner', 'snack', 'shake')`),
  check("food_log_kind_ck", sql`${t.kind} in ('planned', 'skipped', 'swap', 'extra')`),
  check("food_log_item_ck", sql`(
    (${t.recipeSlug} is not null and ${t.servings} is not null and ${t.servings} > 0 and ${t.ingredientSlug} is null and ${t.householdFoodId} is null and ${t.grams} is null)
    or (${t.ingredientSlug} is not null and ${t.grams} is not null and ${t.grams} > 0 and ${t.recipeSlug} is null and ${t.householdFoodId} is null and ${t.servings} is null)
    or (${t.householdFoodId} is not null and ${t.grams} is not null and ${t.grams} > 0 and ${t.recipeSlug} is null and ${t.ingredientSlug} is null and ${t.servings} is null)
  )`),
  check("food_log_planned_ck", sql`${t.plannedServings} is null or ${t.plannedServings} > 0`),
]);

/**
 * Operational log of label-reading calls, for cost caps. Not human-owned and not exported; rows older than 90 days are
 * pruned by lib/server/label-extractions.ts.
 */
export const labelExtractions = pgTable("label_extractions", {
  householdId: ownedHousehold(),
  id: id(),
  personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
  createdAt: isoTimestamp("created_at").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  outcome: text("outcome", { enum: ["success", "unreadable", "invalid", "refused", "error"] }).notNull(),
}, (t) => [
  index("label_extractions_household_idx").on(t.householdId, t.createdAt),
  index("label_extractions_person_idx").on(t.personId, t.createdAt),
  check("label_extractions_outcome_ck", sql`${t.outcome} in ('success', 'unreadable', 'invalid', 'refused', 'error')`),
  check("label_extractions_tokens_ck", sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`),
]);
