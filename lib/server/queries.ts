import { and, desc, eq, inArray, like } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { buildCandidates } from "@/lib/planner/candidates";
import type { Feedback } from "@/lib/planner/candidates";
import { datesBetween } from "@/lib/planner/dates";
import type { PlanMilestones } from "@/lib/planner/feasibility-types";
import { summariseDays } from "@/lib/planner/generate";
import { isIsoWeekday } from "@/lib/planner/weekdays";
import { groceryProgressFrom } from "@/lib/plan/phase";
import type { GroceryProgress } from "@/lib/plan/phase";
import type { PartModes } from "@/lib/parts/mode";
import type { PlanMealRef } from "@/lib/grocery/aggregate";
import type { RoutineInput } from "@/lib/prep/night";
import { getRoutineCatalog, catalogByHabit } from "@/lib/routines/catalog";
import { routineInputs, routineMealRefs } from "@/lib/routines/schedule";
import type { IsoWeekday, PersonRoutineView, PlanRoutineView } from "@/lib/routines/types";
import type { RecipeLinkView } from "@/lib/links/types";
import type { Candidate, DayPersonSummary, PersonTarget, PlanInput, PlannedSlot, Slot } from "@/lib/planner/types";
import { getData, getDb } from "./context";
import { recipeLinksFor } from "./link-view";
import { readPartModes } from "./part-state";
import { readPlanMilestones } from "./plan-progress";
import { readPersonRoutines, readPlanRoutines } from "./routine-state";
import { readTodayRoutines } from "./today-routines";
import type { TodayRoutine } from "./today-routines";
import { resetCounts } from "./reset";
import type { ResetCounts } from "./reset";
import { defaultViewQuery } from "./saved-views";
import { householdFeedback, personalFeedback, planningFeedback } from "./feedback";
import { requireMember } from "../auth/access";
import { resolveOnlyHouseholdAccess } from "../auth/household-access";
import { householdPeople, householdPerson, householdPlan, householdPlans } from "./household-plans";
import { HouseholdAccessError } from "../auth/household";
import type { Db } from "../db/client";

export type PersonRow = typeof s.people.$inferSelect;

async function requestHousehold(db: Db) {
  const member = await requireMember();
  return resolveOnlyHouseholdAccess(db, member.userId);
}

async function requestPlan(db: Db, planId: number) {
  const access = await requestHousehold(db);
  const row = await householdPlan(db, access, planId);
  if (!row) throw new HouseholdAccessError("This plan is not available in your household.");
  await selectedPeople(db, row.setup.personIds, access.householdId);
  return { ...row, access };
}

async function requestPerson(db: Db, personId: number) {
  const person = await householdPerson(db, await requestHousehold(db), personId);
  if (!person) throw new HouseholdAccessError("This profile is not available in your household.");
  return person;
}

async function selectedPeople(db: Db, ids: readonly number[], householdId: string): Promise<PersonRow[]> {
  const people = ids.length ? await db.select().from(s.people).where(and(
    inArray(s.people.id, ids), eq(s.people.householdId, householdId),
  )).orderBy(s.people.id) : [];
  if (!people.length || new Set(ids).size !== ids.length || people.length !== ids.length) {
    throw new HouseholdAccessError("This plan contains profiles outside its household.");
  }
  return people;
}

export function proteinTargetOf(p: PersonRow): number {
  if (p.proteinTargetG) return p.proteinTargetG;
  return Math.round((p.proteinGPerKg ?? 1.2) * p.weightKg);
}

export async function listPeople(): Promise<PersonRow[]> {
  const db = await getDb();
  return householdPeople(db, await requestHousehold(db));
}

export async function getPerson(id: number): Promise<PersonRow | undefined> {
  const db = await getDb();
  return householdPerson(db, await requestHousehold(db), id);
}

export async function getPrefs(personId: number): Promise<{ liked: string[]; avoided: string[] }> {
  const db = await getDb();
  await requestPerson(db, personId);
  const rows = await db
    .select({ kind: s.preferences.kind, slug: s.ingredients.slug })
    .from(s.preferences)
    .innerJoin(s.ingredients, eq(s.ingredients.id, s.preferences.ingredientId))
    .where(eq(s.preferences.personId, personId));
  return {
    liked: rows.filter((r) => r.kind === "like").map((r) => r.slug),
    avoided: rows.filter((r) => r.kind === "avoid").map((r) => r.slug),
  };
}

export async function toPersonTarget(p: PersonRow): Promise<PersonTarget> {
  const prefs = await getPrefs(p.id);
  return {
    id: String(p.id),
    name: p.name,
    proteinTargetG: proteinTargetOf(p),
    kcalTarget: p.kcalTarget,
    liked: new Set(prefs.liked),
    avoided: new Set(prefs.avoided),
  };
}

export async function feedbackMap(personId?: number): Promise<Map<string, Feedback>> {
  const db = await getDb();
  const access = await requestHousehold(db);
  if (personId !== undefined) await selectedPeople(db, [personId], access.householdId);
  return personId === undefined ? householdFeedback(db, access.householdId) : personalFeedback(db, personId, access.householdId);
}

export async function getCandidates(personIds: readonly number[] = []): Promise<Candidate[]> {
  const db = await getDb();
  const access = await requestHousehold(db);
  if (personIds.length) await selectedPeople(db, personIds, access.householdId);
  return buildCandidates(getData(), await planningFeedback(db, personIds, access.householdId));
}

export async function recipeIds(): Promise<{ bySlug: Map<string, number>; byId: Map<number, string> }> {
  const rows = await (await getDb()).select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes);
  return { bySlug: new Map(rows.map((r) => [r.slug, r.id])), byId: new Map(rows.map((r) => [r.id, r.slug])) };
}

export async function ingredientIds(): Promise<{ bySlug: Map<string, number>; byId: Map<number, string> }> {
  const rows = await (await getDb()).select({ id: s.ingredients.id, slug: s.ingredients.slug }).from(s.ingredients);
  return { bySlug: new Map(rows.map((r) => [r.slug, r.id])), byId: new Map(rows.map((r) => [r.id, r.slug])) };
}

export interface StoredSlot extends PlannedSlot {
  id: number;
}

export interface PlanView {
  id: number;
  setupId: number;
  seed: number;
  createdAt: string;
  startDate: string;
  endDate: string;
  dates: string[];
  mealTypes: Slot[];
  cuisineBalance: number;
  maxActiveMin: number | null;
  /** Chosen weekdays (ISO 1 to 7), or null when the plan has no preference. */
  shoppingDay: IsoWeekday | null;
  prepDay: IsoWeekday | null;
  people: PersonRow[];
  slots: StoredSlot[];
  days: DayPersonSummary[];
  input: PlanInput;
}

export async function latestPlanId(): Promise<number | undefined> {
  return (await listPlans(1))[0]?.id;
}

export async function listPlans(limit = 10): Promise<{ id: number; startDate: string; endDate: string; createdAt: string }[]> {
  const db = await getDb();
  return householdPlans(db, await requestHousehold(db), limit);
}

export async function getPlanView(planId: number, candidates?: Candidate[]): Promise<PlanView | undefined> {
  if (!Number.isSafeInteger(planId) || planId <= 0) return undefined;
  const db = await getDb();
  const access = await requestHousehold(db);
  const row = await householdPlan(db, access, planId);
  if (!row) return undefined;
  const people = await selectedPeople(db, row.setup.personIds, access.householdId);
  const cands = candidates ?? (await getCandidates(row.setup.personIds));
  const rid = await recipeIds();
  const slotRows = await db.select().from(s.planSlots).where(eq(s.planSlots.planId, planId)).orderBy(s.planSlots.date, s.planSlots.id);
  const portionRows = slotRows.length
    ? await db.select().from(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slotRows.map((r) => r.id)))
    : [];
  if (portionRows.some((portion) => !row.setup.personIds.includes(portion.personId))) {
    throw new HouseholdAccessError("This plan contains portions outside its selected profiles.");
  }
  const slots: StoredSlot[] = slotRows.map((r) => ({
    id: r.id,
    date: r.date,
    slot: r.slot,
    recipeSlug: rid.byId.get(r.recipeId) ?? "",
    locked: r.locked,
    isLeftover: r.isLeftover,
    servings: Object.fromEntries(portionRows.filter((p) => p.planSlotId === r.id).map((p) => [String(p.personId), p.servings])),
    reasons: [],
  }));
  const dates = datesBetween(row.setup.startDate, row.setup.endDate);
  const targets = await Promise.all(people.map(toPersonTarget));
  const input: PlanInput = {
    dates,
    mealTypes: row.setup.mealTypes as Slot[],
    people: targets,
    cuisineBalance: row.setup.cuisineBalance,
    maxActiveMin: row.setup.maxActiveMin,
    healthFocus: row.setup.healthFocus ?? undefined,
    prepStyle: row.setup.prepStyle ?? undefined,
    pinnedRecipes: [],
    locked: slots.filter((x) => x.locked).map((x) => ({ date: x.date, slot: x.slot, recipeSlug: x.recipeSlug })),
    seed: row.plan.seed,
  };
  const byslug = new Map(cands.map((c) => [c.slug, c]));
  return {
    id: planId,
    setupId: row.setup.id,
    seed: row.plan.seed,
    createdAt: row.plan.createdAt,
    startDate: row.setup.startDate,
    endDate: row.setup.endDate,
    dates,
    mealTypes: input.mealTypes as Slot[],
    cuisineBalance: row.setup.cuisineBalance,
    maxActiveMin: row.setup.maxActiveMin,
    shoppingDay: isIsoWeekday(row.setup.shoppingDay) ? row.setup.shoppingDay : null,
    prepDay: isIsoWeekday(row.setup.prepDay) ? row.setup.prepDay : null,
    people,
    slots,
    days: summariseDays(slots, targets, byslug, dates),
    input,
  };
}

export async function lastSetup(): Promise<{ personIds: number[]; mealTypes: Slot[]; cuisineBalance: number; maxActiveMin: number | null; days: number; healthFocus: { nutrientDense: boolean; lowSugar: boolean; light: boolean } | null; prepStyle: "variety" | "leftovers" | "batch" | null } | undefined> {
  const db = await getDb();
  const access = await requestHousehold(db);
  const [r] = await db.select().from(s.planSetups).where(eq(s.planSetups.householdId, access.householdId)).orderBy(desc(s.planSetups.id)).limit(1);
  if (!r) return undefined;
  const days = datesBetween(r.startDate, r.endDate).length;
  return { personIds: r.personIds, mealTypes: r.mealTypes as Slot[], cuisineBalance: r.cuisineBalance, maxActiveMin: r.maxActiveMin, days, healthFocus: r.healthFocus, prepStyle: r.prepStyle };
}

export async function groceryChecks(planId: number): Promise<{ checked: Set<string>; manual: { id: number; text: string; checked: boolean }[] }> {
  const db = await getDb();
  await requestPlan(db, planId);
  const ids = await ingredientIds();
  const rows = await db.select().from(s.groceryState).where(and(eq(s.groceryState.planId, planId), eq(s.groceryState.checked, true)));
  const manual = await db.select().from(s.groceryManual).where(eq(s.groceryManual.planId, planId));
  return {
    checked: new Set(rows.map((r) => ids.byId.get(r.ingredientId) ?? "")),
    manual: manual.map((m) => ({ id: m.id, text: m.text, checked: m.checked })),
  };
}

export interface SavedView {
  id: number;
  name: string;
  query: string;
  isDefault: boolean;
}

export async function getSavedViews(list: string): Promise<SavedView[]> {
  const db = await getDb();
  const access = await requestHousehold(db);
  return db.select({ id: s.savedViews.id, name: s.savedViews.name, query: s.savedViews.query, isDefault: s.savedViews.isDefault })
    .from(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.householdId, access.householdId))).orderBy(s.savedViews.id);
}

/** The query string saved as this list's default view, or null. */
export async function getDefaultViewQuery(list: string): Promise<string | null> {
  const db = await getDb();
  return defaultViewQuery(db, list, (await requestHousehold(db)).householdId);
}

/** How each part of a meal is provided for one plan; a part not in the result is made. */
export async function getPartModes(planId: number): Promise<PartModes> {
  const db = await getDb();
  await requestPlan(db, planId);
  return readPartModes(db, planId);
}

/** Each routine one person chose (days, time of day, servings). The profile page lists them. */
export async function getPersonRoutines(personId: number): Promise<PersonRoutineView[]> {
  const db = await getDb();
  await requestPerson(db, personId);
  return readPersonRoutines(db, personId);
}

/** A person's routines scheduled on `date`'s weekday, ticked or not, for the morning card on Today. */
export async function getTodayRoutines(personId: number, date: string): Promise<TodayRoutine[]> {
  const db = await getDb();
  await requestPerson(db, personId);
  return readTodayRoutines(db, personId, date);
}

/** What a plan took from its people's routine choices when it was generated. */
export async function getPlanRoutines(planId: number): Promise<PlanRoutineView[]> {
  const db = await getDb();
  const { setup } = await requestPlan(db, planId);
  const rows = await readPlanRoutines(db, planId);
  if (rows.some((row) => !setup.personIds.includes(row.personId))) {
    throw new HouseholdAccessError("This plan contains routines outside its selected profiles.");
  }
  return rows;
}

/**
 * A plan's routines as the two things the rest of the app consumes: grocery references (items scaled by scheduled days and
 * people) and night-before inputs (one per person's choice). Empty when nobody chose a routine.
 */
export async function routineContext(view: { id: number; dates: string[] }): Promise<{ refs: PlanMealRef[]; inputs: RoutineInput[] }> {
  const choices = await getPlanRoutines(view.id);
  if (choices.length === 0) return { refs: [], inputs: [] };
  const catalog = catalogByHabit(getRoutineCatalog(getData()));
  return { refs: routineMealRefs(choices, view.dates, catalog), inputs: routineInputs(choices, view.dates, catalog) };
}

/** Items left to buy for a whole plan, counted the way the Groceries page counts them. */
export async function groceryProgress(view: PlanView): Promise<GroceryProgress> {
  const data = getData();
  const meals = view.slots.map((sl) => ({ recipeSlug: sl.recipeSlug, servings: Object.values(sl.servings).reduce((a, b) => a + b, 0) }));
  const { refs } = await routineContext(view);
  return groceryProgressFrom(meals, data.recipes, data.ingredients, (await groceryChecks(view.id)).checked, await getPartModes(view.id), refs);
}

// ---------- Reads that pages used to do themselves ----------

export interface HabitRow {
  id: number;
  slug: string;
  title: string;
  category: string;
  evidenceGrade: string;
  evidenceNote: string;
  sourceUrl: string | null;
  caution: string | null;
  defaultOn: boolean;
}

/** Every habit from the library, plus the ids this person ticked on `date`. */
export async function getHabitsFor(date: string, personId: number): Promise<{ habits: HabitRow[]; doneIds: Set<number> }> {
  const db = await getDb();
  await requestPerson(db, personId);
  const habits = await db.select().from(s.habits);
  const log = await db.select().from(s.habitLog).where(and(eq(s.habitLog.date, date), eq(s.habitLog.personId, personId)));
  return { habits, doneIds: new Set(log.filter((r) => r.done).map((r) => r.habitId)) };
}

/** Tick rows saved under the old `prep:{planId}:` key format, for the batch-cook sessions on the prep page. */
export async function getBatchPrepTicks(planId: number): Promise<{ taskKey: string; done: boolean }[]> {
  const db = await getDb();
  const { access } = await requestPlan(db, planId);
  return db.select({ taskKey: s.prepTaskState.taskKey, done: s.prepTaskState.done }).from(s.prepTaskState).where(and(
    eq(s.prepTaskState.householdId, access.householdId), like(s.prepTaskState.taskKey, `prep:${planId}:%`),
  ));
}

/** What a reset would delete, for the Settings page. */
export async function getResetCounts(): Promise<ResetCounts> {
  return resetCounts(await getDb());
}

/** Every link saved on a recipe page, in display order, with video embeds worked out. See link-view.ts. */
export async function getRecipeLinks(recipeSlug: string): Promise<RecipeLinkView[]> {
  const db = await getDb();
  return recipeLinksFor(db, recipeSlug, (await requestHousehold(db)).householdId);
}

/** Which of the three after-plan steps are done. All three keys are always present. */
export async function getPlanMilestones(planId: number): Promise<PlanMilestones> {
  const db = await getDb();
  await requestPlan(db, planId);
  return readPlanMilestones(db, planId);
}

/** Milestones of the newest plan, or null when there is no plan. */
export async function latestPlanMilestones(): Promise<{ planId: number; milestones: PlanMilestones } | null> {
  const planId = await latestPlanId();
  return planId === undefined ? null : { planId, milestones: await getPlanMilestones(planId) };
}
