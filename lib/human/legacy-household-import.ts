import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { HouseholdAccessError, lockHousehold } from "../auth/household";
import { refreshHouseholdAccess, type HouseholdAccess } from "../auth/household-access";
import { parseLegacyBundle, type LegacyBundle } from "../legacy/bundle";
import { insertLegacyFeedback } from "./feedback";
import { insertLegacyLinks } from "./links";
import { insertLegacyPersonRoutines } from "./routines";
import { insertLegacySavedViews } from "./saved-views";

export class LegacyImportError extends Error {
  override name = "LegacyImportError";
}

export interface LegacyImportOptions {
  /** false: run every write inside the transaction, count it, then roll back. */
  commit: boolean;
  /** Person key of a bundle person to link to the owner's membership. */
  linkPerson?: string | null;
  /** data/renames.json, applied to bundle recipe slugs on top of the renames applied when the bundle was built. */
  renames?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface LegacyImportReport {
  dryRun: boolean;
  /** Rows written (or that would be written), by class. */
  imported: Record<string, number>;
  /** Rows left out, by class: an unknown slug, a person missing from the bundle, or a duplicate after a rename. */
  skipped: Record<string, number>;
  /** Distinct slugs this app does not know, so the owner can see what was dropped. Capped at 25 each. */
  unknown: { recipes: string[]; ingredients: string[]; habits: string[] };
  linkedPerson: boolean;
  removedOnboardingProfile: boolean;
}

export const legacyImportEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => env.LEGACY_IMPORT_ENABLED === "true";

/** Thrown inside the transaction to roll a dry run back while still returning its report. */
class DryRun extends Error {
  constructor(readonly report: LegacyImportReport) { super("dry run"); }
}

const CHUNK = 200;
const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};
const UNKNOWN_CAP = 25;

/**
 * Imports a verified bundle into the caller's own household, once. Everything happens in one transaction under the
 * household admission lock; the caller must be an owner of the selected household. Nothing outside that household is
 * read for writing, and nothing is marked changed in sync_state: this restores the owner's existing data, it is not a
 * new human change. Refuses a household that already has plans, feedback, links, views or a pantry, and any bundle
 * whose uids are already in the database, so a second run can never duplicate.
 */
export async function importLegacyBundle(db: Db, access: HouseholdAccess, text: string, options: LegacyImportOptions): Promise<LegacyImportReport> {
  if (!legacyImportEnabled(options.env ?? process.env)) throw new LegacyImportError("The legacy import is not enabled on this instance.");
  const bundle = parseLegacyBundle(text);
  try {
    const report = await withTx(db, (tx) => run(tx, access, bundle, options));
    return report;
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}

async function run(tx: Tx, input: HouseholdAccess, bundle: LegacyBundle, options: LegacyImportOptions): Promise<LegacyImportReport> {
  await lockHousehold(tx);
  const access = await refreshHouseholdAccess(tx, input);
  if (access.role !== "owner") throw new LegacyImportError("Only a household owner can import the old data.");
  const householdId = access.householdId;
  await tx.select({ id: s.households.id }).from(s.households).where(eq(s.households.id, householdId)).for("update");
  const { data } = bundle;
  const renames = options.renames ?? {};
  const rename = (slug: string) => renames[slug] ?? slug;

  // ---- refusals: the target must be an empty household and the bundle must be new ----
  const uidTaken = async (uids: readonly string[], column: PgColumn): Promise<boolean> =>
    uids.length > 0 && (await tx.select({ uid: column }).from(column.table as PgTable).where(inArray(column, [...uids])).limit(1)).length > 0;
  if (await uidTaken(data.recipe_feedback.map((r) => r.uid), s.recipeFeedback.uid) ||
      await uidTaken(data.recipe_links.map((r) => r.uid), s.recipeLinks.uid) ||
      await uidTaken(data.saved_views.map((r) => r.uid), s.savedViews.uid) ||
      await uidTaken(data.person_routines.map((r) => r.uid), s.personRoutines.uid)) {
    throw new LegacyImportError("This bundle has already been imported. Nothing was changed.");
  }
  const occupied: [string, typeof s.plans | typeof s.planSetups | typeof s.recipeFeedback | typeof s.recipeLinks | typeof s.savedViews | typeof s.pantry | typeof s.prepTaskState][] = [
    ["plans", s.plans], ["plans", s.planSetups], ["feedback", s.recipeFeedback], ["links", s.recipeLinks],
    ["saved views", s.savedViews], ["a pantry", s.pantry], ["prep progress", s.prepTaskState],
  ];
  for (const [label, table] of occupied) {
    const [row] = await tx.select({ id: table.householdId }).from(table).where(eq(table.householdId, householdId)).limit(1);
    if (row) throw new LegacyImportError(`This household already has ${label}. The import only fills an empty household, so nothing was changed.`);
  }

  // ---- library lookups by slug ----
  const toMap = (rows: { id: number; slug: string }[]) => new Map(rows.map((r) => [r.slug, r.id]));
  const recipes = toMap(await tx.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes));
  const ingredients = toMap(await tx.select({ id: s.ingredients.id, slug: s.ingredients.slug }).from(s.ingredients));
  const habits = toMap(await tx.select({ id: s.habits.id, slug: s.habits.slug }).from(s.habits));
  const unknown = { recipes: new Set<string>(), ingredients: new Set<string>(), habits: new Set<string>() };
  const imported: Record<string, number> = {}, skipped: Record<string, number> = {};
  const bump = (m: Record<string, number>, name: string, by = 1) => { m[name] = (m[name] ?? 0) + by; };
  const recipeId = (slug: string): number | undefined => {
    const id = recipes.get(rename(slug));
    if (id === undefined) unknown.recipes.add(rename(slug));
    return id;
  };
  const ingredientId = (slug: string): number | undefined => {
    const id = ingredients.get(slug);
    if (id === undefined) unknown.ingredients.add(slug);
    return id;
  };
  const habitId = (slug: string): number | undefined => {
    const id = habits.get(slug);
    if (id === undefined) unknown.habits.add(slug);
    return id;
  };

  // ---- people and their preferences ----
  const personIds = new Map<string, number>();
  for (const part of chunks(data.people)) {
    const created = await tx.insert(s.people).values(part.map((p) => ({
      householdId, name: p.name, sex: p.sex, birthDate: p.birth_date, heightCm: p.height_cm, weightKg: p.weight_kg,
      activityLevel: p.activity_level, proteinTargetG: p.protein_target_g, proteinGPerKg: p.protein_g_per_kg, kcalTarget: p.kcal_target,
      reminderTime: p.reminder_time, dietFlags: p.diet_flags,
    }))).returning({ id: s.people.id });
    part.forEach((p, i) => personIds.set(p.key, created[i]!.id));
  }
  imported.people = personIds.size;
  const person = (key: string): number | undefined => personIds.get(key);
  const creator = (key: string | null): number | null => (key === null ? null : person(key) ?? null);

  const prefs: (typeof s.preferences.$inferInsert)[] = [];
  for (const p of data.people) {
    for (const pref of p.preferences) {
      const ing = pref.ingredient === null ? null : ingredientId(pref.ingredient);
      const rec = pref.recipe === null ? null : recipeId(pref.recipe);
      if (ing === undefined || rec === undefined) { bump(skipped, "preferences"); continue; }
      prefs.push({ personId: person(p.key)!, ingredientId: ing, recipeId: rec, kind: pref.kind });
    }
  }
  for (const part of chunks(prefs)) await tx.insert(s.preferences).values(part);
  imported.preferences = prefs.length;

  // ---- human-owned classes, written through their lib/human modules ----
  const seenRecipes = new Set<number>();
  const feedback: Parameters<typeof insertLegacyFeedback>[2][number][] = [];
  for (const r of data.recipe_feedback) {
    const id = recipeId(r.recipe);
    if (id === undefined || seenRecipes.has(id)) { bump(skipped, "recipe_feedback"); continue; }
    seenRecipes.add(id);
    feedback.push({
      recipeId: id, uid: r.uid, status: r.status, rating: r.rating, favourite: r.favourite, banned: r.banned, notes: r.notes,
      testedAt: r.tested_at, createdAt: r.created_at, updatedAt: r.updated_at, createdByPersonId: creator(r.created_by),
    });
  }
  for (const part of chunks(feedback)) await insertLegacyFeedback(tx, householdId, part);
  imported.recipe_feedback = feedback.length;

  const links: Parameters<typeof insertLegacyLinks>[2][number][] = [];
  for (const r of data.recipe_links) {
    const id = recipeId(r.recipe);
    if (id === undefined) { bump(skipped, "recipe_links"); continue; }
    links.push({
      recipeId: id, uid: r.uid, partSlug: r.part_slug === null ? null : rename(r.part_slug), stepNo: r.step_no, kind: r.kind, url: r.url,
      title: r.title, source: r.source, startSec: r.start_sec, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at,
      createdByPersonId: creator(r.created_by),
    });
  }
  for (const part of chunks(links)) await insertLegacyLinks(tx, householdId, part);
  imported.recipe_links = links.length;

  for (const part of chunks(data.saved_views)) {
    await insertLegacySavedViews(tx, householdId, part.map((r) => ({
      uid: r.uid, list: r.list, name: r.name, query: r.query, isDefault: r.is_default, createdAt: r.created_at, updatedAt: r.updated_at,
      createdByPersonId: creator(r.created_by),
    })));
  }
  imported.saved_views = data.saved_views.length;

  const routines: Parameters<typeof insertLegacyPersonRoutines>[1][number][] = [];
  for (const r of data.person_routines) {
    const owner = person(r.person), habit = habitId(r.habit);
    if (owner === undefined || habit === undefined) { bump(skipped, "person_routines"); continue; }
    routines.push({
      personId: owner, habitId: habit, uid: r.uid, days: r.days, timeOfDay: r.time_of_day, servings: r.servings, active: r.active,
      createdAt: r.created_at, updatedAt: r.updated_at, createdByPersonId: creator(r.created_by),
    });
  }
  for (const part of chunks(routines)) await insertLegacyPersonRoutines(tx, part);
  imported.person_routines = routines.length;

  // ---- household state without a human module ----
  const pantry: (typeof s.pantry.$inferInsert)[] = [];
  for (const r of data.pantry) {
    const id = ingredientId(r.ingredient);
    if (id === undefined) { bump(skipped, "pantry"); continue; }
    pantry.push({ householdId, ingredientId: id, have: r.have, alwaysStock: r.always_stock });
  }
  for (const part of chunks(pantry)) await tx.insert(s.pantry).values(part);
  imported.pantry = pantry.length;

  const log: (typeof s.habitLog.$inferInsert)[] = [];
  for (const r of data.habit_log) {
    const owner = person(r.person), habit = habitId(r.habit);
    if (owner === undefined || habit === undefined) { bump(skipped, "habit_log"); continue; }
    log.push({ date: r.date, personId: owner, habitId: habit, done: r.done });
  }
  for (const part of chunks(log)) await tx.insert(s.habitLog).values(part);
  imported.habit_log = log.length;

  if (bundle.with_plans) await importPlans(tx, householdId, bundle, { person, recipeId, ingredientId, habitId, rename }, imported, skipped);

  // ---- optional: the owner's membership takes the named legacy person ----
  let linkedPerson = false, removedOnboardingProfile = false;
  if (options.linkPerson) {
    const target = person(options.linkPerson);
    if (target === undefined) throw new LegacyImportError("The person you chose is not in this bundle.");
    const [member] = await tx.select().from(s.householdMembers)
      .where(and(eq(s.householdMembers.userId, access.userId), eq(s.householdMembers.householdId, householdId))).for("update");
    if (!member) throw new HouseholdAccessError("This household is not available to your verified account.");
    const previous = member.personId;
    await tx.update(s.householdMembers).set({ personId: target, updatedAt: new Date() })
      .where(and(eq(s.householdMembers.userId, access.userId), eq(s.householdMembers.householdId, householdId)));
    linkedPerson = true;
    if (previous !== null && await profileIsEmpty(tx, previous)) {
      await tx.delete(s.people).where(and(eq(s.people.id, previous), eq(s.people.householdId, householdId)));
      removedOnboardingProfile = true;
    }
  }

  const report: LegacyImportReport = {
    dryRun: !options.commit, imported, skipped,
    unknown: {
      recipes: [...unknown.recipes].sort().slice(0, UNKNOWN_CAP), ingredients: [...unknown.ingredients].sort().slice(0, UNKNOWN_CAP),
      habits: [...unknown.habits].sort().slice(0, UNKNOWN_CAP),
    },
    linkedPerson, removedOnboardingProfile,
  };
  if (!options.commit) throw new DryRun(report);
  return report;
}

interface Resolvers {
  person: (key: string) => number | undefined;
  recipeId: (slug: string) => number | undefined;
  ingredientId: (slug: string) => number | undefined;
  habitId: (slug: string) => number | undefined;
  rename: (slug: string) => string;
}

async function importPlans(
  tx: Tx, householdId: string, bundle: LegacyBundle, r: Resolvers, imported: Record<string, number>, skipped: Record<string, number>,
) {
  const { data } = bundle;
  const bump = (m: Record<string, number>, name: string, by = 1) => { m[name] = (m[name] ?? 0) + by; };
  for (const name of ["plan_setups", "plans", "plan_slots", "plan_slot_portions", "plan_routines", "grocery_state", "grocery_manual", "plan_part_state", "plan_progress", "prep_task_state"]) imported[name] = 0;

  // person_ids inside setups are remapped from person keys to the new profile ids.
  const setupIds = new Map<string, number>();
  for (const setup of data.plan_setups) {
    const ids = setup.people.map((key) => r.person(key));
    if (ids.some((id) => id === undefined)) { bump(skipped, "plan_setups"); continue; }
    const [row] = await tx.insert(s.planSetups).values({
      householdId, personIds: ids as number[], startDate: setup.start_date, endDate: setup.end_date, mealTypes: setup.meal_types,
      cuisineBalance: setup.cuisine_balance, maxActiveMin: setup.max_active_min, healthFocus: setup.health_focus, prepStyle: setup.prep_style,
      shoppingDay: setup.shopping_day, prepDay: setup.prep_day, createdAt: setup.created_at,
    }).returning({ id: s.planSetups.id });
    setupIds.set(setup.ref, row!.id);
    imported.plan_setups = (imported.plan_setups ?? 0) + 1;
  }

  const planIds = new Map<string, number>();
  for (const plan of data.plans) {
    const setupId = setupIds.get(plan.setup);
    if (setupId === undefined) { bump(skipped, "plans"); continue; }
    const [row] = await tx.insert(s.plans).values({ householdId, setupId, seed: plan.seed, createdAt: plan.created_at }).returning({ id: s.plans.id });
    const planId = row!.id;
    planIds.set(plan.ref, planId);
    bump(imported, "plans");

    const slots = plan.slots.flatMap((slot) => {
      const recipe = r.recipeId(slot.recipe);
      if (recipe === undefined) { bump(skipped, "plan_slots"); return []; }
      return [{ slot, values: { planId, date: slot.date, slot: slot.slot, recipeId: recipe, locked: slot.locked, isLeftover: slot.is_leftover } }];
    });
    const portions: (typeof s.planSlotPortions.$inferInsert)[] = [];
    for (const part of chunks(slots)) {
      const created = await tx.insert(s.planSlots).values(part.map((x) => x.values)).returning({ id: s.planSlots.id });
      part.forEach((x, i) => {
        for (const p of x.slot.portions) {
          const owner = r.person(p.person);
          if (owner === undefined) { bump(skipped, "plan_slot_portions"); continue; }
          portions.push({ planSlotId: created[i]!.id, personId: owner, servings: p.servings });
        }
      });
    }
    bump(imported, "plan_slots", slots.length);
    for (const part of chunks(portions)) await tx.insert(s.planSlotPortions).values(part);
    bump(imported, "plan_slot_portions", portions.length);

    const routines: (typeof s.planRoutines.$inferInsert)[] = [];
    for (const x of plan.routines) {
      const owner = r.person(x.person), habit = r.habitId(x.habit);
      if (owner === undefined || habit === undefined) { bump(skipped, "plan_routines"); continue; }
      routines.push({ planId, personId: owner, habitId: habit, days: x.days, timeOfDay: x.time_of_day, servings: x.servings });
    }
    for (const part of chunks(routines)) await tx.insert(s.planRoutines).values(part);
    bump(imported, "plan_routines", routines.length);

    const grocery: (typeof s.groceryState.$inferInsert)[] = [];
    for (const x of plan.grocery) {
      const ingredient = r.ingredientId(x.ingredient);
      if (ingredient === undefined) { bump(skipped, "grocery_state"); continue; }
      grocery.push({ planId, ingredientId: ingredient, checked: x.checked });
    }
    for (const part of chunks(grocery)) await tx.insert(s.groceryState).values(part);
    bump(imported, "grocery_state", grocery.length);

    for (const part of chunks(plan.manual)) await tx.insert(s.groceryManual).values(part.map((x) => ({ planId, text: x.text, checked: x.checked })));
    bump(imported, "grocery_manual", plan.manual.length);

    // A component renamed since the bundle was built follows the rename; a duplicate after renaming keeps the first.
    const parts = new Map<string, typeof s.planPartState.$inferInsert>();
    for (const x of plan.part_state) {
      const component = r.rename(x.component);
      if (parts.has(component)) { bump(skipped, "plan_part_state"); continue; }
      parts.set(component, { planId, componentSlug: component, mode: x.mode, updatedAt: x.updated_at });
    }
    for (const part of chunks([...parts.values()])) await tx.insert(s.planPartState).values(part);
    bump(imported, "plan_part_state", parts.size);

    for (const part of chunks(plan.progress)) await tx.insert(s.planProgress).values(part.map((x) => ({ planId, step: x.step, doneAt: x.done_at })));
    bump(imported, "plan_progress", plan.progress.length);
  }

  const tasks: (typeof s.prepTaskState.$inferInsert)[] = [];
  for (const t of data.prep_tasks) {
    const m = /^(night|prep):@(plan-\d+):/.exec(t.task_key);
    if (!m) { tasks.push({ householdId, date: t.date, taskKey: t.task_key, done: t.done }); continue; }
    const planId = planIds.get(m[2]!);
    if (planId === undefined) { bump(skipped, "prep_task_state"); continue; }
    tasks.push({ householdId, date: t.date, taskKey: `${m[1]}:${planId}:${t.task_key.slice(m[0].length)}`, done: t.done });
  }
  for (const part of chunks(tasks)) await tx.insert(s.prepTaskState).values(part).onConflictDoNothing();
  imported.prep_task_state = tasks.length;
}

/** True when nothing but the profile row itself refers to the person, so deleting it loses nothing. */
async function profileIsEmpty(tx: Tx, personId: number): Promise<boolean> {
  const used = async (table: PgTable, where: SQL | undefined): Promise<boolean> =>
    (await tx.select({ n: sql<number>`1` }).from(table).where(where).limit(1)).length > 0;
  const checks: [PgTable, SQL | undefined][] = [
    [s.preferences, eq(s.preferences.personId, personId)],
    [s.personRoutines, or(eq(s.personRoutines.personId, personId), eq(s.personRoutines.createdByPersonId, personId))],
    [s.habitLog, eq(s.habitLog.personId, personId)],
    [s.planSlotPortions, eq(s.planSlotPortions.personId, personId)],
    [s.planRoutines, eq(s.planRoutines.personId, personId)],
    [s.personRecipeFeedback, or(eq(s.personRecipeFeedback.personId, personId), eq(s.personRecipeFeedback.createdByPersonId, personId))],
    [s.pushSubscriptions, eq(s.pushSubscriptions.personId, personId)],
    [s.reminderLog, eq(s.reminderLog.personId, personId)],
    [s.reminderBatches, eq(s.reminderBatches.personId, personId)],
    [s.recipeFeedback, eq(s.recipeFeedback.createdByPersonId, personId)],
    [s.recipeLinks, eq(s.recipeLinks.createdByPersonId, personId)],
    [s.savedViews, eq(s.savedViews.createdByPersonId, personId)],
    [s.photos, eq(s.photos.createdByPersonId, personId)],
    [s.photoDecisions, eq(s.photoDecisions.createdByPersonId, personId)],
  ];
  for (const [table, where] of checks) if (await used(table, where)) return false;
  return true;
}
