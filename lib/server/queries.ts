import { and, desc, eq, inArray, like } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { buildCandidates } from "@/lib/planner/candidates";
import type { Feedback } from "@/lib/planner/candidates";
import { datesBetween } from "@/lib/planner/dates";
import { summariseDays } from "@/lib/planner/generate";
import { groceryProgressFrom } from "@/lib/plan/phase";
import type { GroceryProgress } from "@/lib/plan/phase";
import type { Candidate, DayPersonSummary, PersonTarget, PlanInput, PlannedSlot, Slot } from "@/lib/planner/types";
import { getData, getDb } from "./context";
import { resetCounts } from "./reset";
import type { ResetCounts } from "./reset";
import { defaultViewQuery } from "./saved-views";

export type PersonRow = typeof s.people.$inferSelect;

export function proteinTargetOf(p: PersonRow): number {
  if (p.proteinTargetG) return p.proteinTargetG;
  return Math.round((p.proteinGPerKg ?? 1.2) * p.weightKg);
}

export async function listPeople(): Promise<PersonRow[]> {
  return (await getDb()).select().from(s.people).orderBy(s.people.id);
}

export async function getPerson(id: number): Promise<PersonRow | undefined> {
  const [row] = await (await getDb()).select().from(s.people).where(eq(s.people.id, id)).limit(1);
  return row;
}

export async function getPrefs(personId: number): Promise<{ liked: string[]; avoided: string[] }> {
  const rows = await (await getDb())
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

export async function feedbackMap(): Promise<Map<string, Feedback>> {
  const rows = await (await getDb())
    .select({
      slug: s.recipes.slug,
      favourite: s.recipeFeedback.favourite,
      banned: s.recipeFeedback.banned,
      rating: s.recipeFeedback.rating,
      status: s.recipeFeedback.status,
    })
    .from(s.recipeFeedback)
    .innerJoin(s.recipes, eq(s.recipes.id, s.recipeFeedback.recipeId));
  return new Map(rows.map((r) => [r.slug, { favourite: r.favourite, banned: r.banned, rating: r.rating, tested: r.status === "tested" }]));
}

export async function getCandidates(): Promise<Candidate[]> {
  return buildCandidates(getData(), await feedbackMap());
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
  people: PersonRow[];
  slots: StoredSlot[];
  days: DayPersonSummary[];
  input: PlanInput;
}

export async function latestPlanId(): Promise<number | undefined> {
  const [row] = await (await getDb()).select({ id: s.plans.id }).from(s.plans).orderBy(desc(s.plans.id)).limit(1);
  return row?.id;
}

export async function listPlans(limit = 10): Promise<{ id: number; startDate: string; endDate: string; createdAt: string }[]> {
  return (await getDb())
    .select({ id: s.plans.id, startDate: s.planSetups.startDate, endDate: s.planSetups.endDate, createdAt: s.plans.createdAt })
    .from(s.plans)
    .innerJoin(s.planSetups, eq(s.planSetups.id, s.plans.setupId))
    .orderBy(desc(s.plans.id))
    .limit(limit);
}

export async function getPlanView(planId: number, candidates?: Candidate[]): Promise<PlanView | undefined> {
  const db = await getDb();
  const [row] = await db
    .select({ plan: s.plans, setup: s.planSetups })
    .from(s.plans)
    .innerJoin(s.planSetups, eq(s.planSetups.id, s.plans.setupId))
    .where(eq(s.plans.id, planId))
    .limit(1);
  if (!row) return undefined;
  const cands = candidates ?? (await getCandidates());
  const people = row.setup.personIds.length
    ? await db.select().from(s.people).where(inArray(s.people.id, row.setup.personIds)).orderBy(s.people.id)
    : [];
  const rid = await recipeIds();
  const slotRows = await db.select().from(s.planSlots).where(eq(s.planSlots.planId, planId)).orderBy(s.planSlots.date, s.planSlots.id);
  const portionRows = slotRows.length
    ? await db.select().from(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slotRows.map((r) => r.id)))
    : [];
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
    people,
    slots,
    days: summariseDays(slots, targets, byslug, dates),
    input,
  };
}

export async function lastSetup(): Promise<{ personIds: number[]; mealTypes: Slot[]; cuisineBalance: number; maxActiveMin: number | null; days: number; healthFocus: { nutrientDense: boolean; lowSugar: boolean; light: boolean } | null; prepStyle: "variety" | "leftovers" | "batch" | null } | undefined> {
  const [r] = await (await getDb()).select().from(s.planSetups).orderBy(desc(s.planSetups.id)).limit(1);
  if (!r) return undefined;
  const days = datesBetween(r.startDate, r.endDate).length;
  return { personIds: r.personIds, mealTypes: r.mealTypes as Slot[], cuisineBalance: r.cuisineBalance, maxActiveMin: r.maxActiveMin, days, healthFocus: r.healthFocus, prepStyle: r.prepStyle };
}

export async function groceryChecks(planId: number): Promise<{ checked: Set<string>; manual: { id: number; text: string; checked: boolean }[] }> {
  const db = await getDb();
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
  return (await getDb()).select({ id: s.savedViews.id, name: s.savedViews.name, query: s.savedViews.query, isDefault: s.savedViews.isDefault }).from(s.savedViews).where(eq(s.savedViews.list, list)).orderBy(s.savedViews.id);
}

/** The query string saved as this list's default view, or null. */
export async function getDefaultViewQuery(list: string): Promise<string | null> {
  return defaultViewQuery(await getDb(), list);
}

/** Items left to buy for a whole plan, counted the way the Groceries page counts them. */
export async function groceryProgress(view: PlanView): Promise<GroceryProgress> {
  const data = getData();
  const meals = view.slots.map((sl) => ({ recipeSlug: sl.recipeSlug, servings: Object.values(sl.servings).reduce((a, b) => a + b, 0) }));
  return groceryProgressFrom(meals, data.recipes, data.ingredients, (await groceryChecks(view.id)).checked);
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
  const habits = await db.select().from(s.habits);
  const log = await db.select().from(s.habitLog).where(and(eq(s.habitLog.date, date), eq(s.habitLog.personId, personId)));
  return { habits, doneIds: new Set(log.filter((r) => r.done).map((r) => r.habitId)) };
}

/** Tick rows saved under the old `prep:{planId}:` key format, for the batch-cook sessions on the prep page. */
export async function getBatchPrepTicks(planId: number): Promise<{ taskKey: string; done: boolean }[]> {
  return (await getDb()).select({ taskKey: s.prepTaskState.taskKey, done: s.prepTaskState.done }).from(s.prepTaskState).where(like(s.prepTaskState.taskKey, `prep:${planId}:%`));
}

/** What a reset would delete, for the Settings page. */
export async function getResetCounts(): Promise<ResetCounts> {
  return resetCounts(await getDb());
}
