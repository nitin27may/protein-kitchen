import { and, desc, eq, inArray } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { buildCandidates } from "@/lib/planner/candidates";
import type { Feedback } from "@/lib/planner/candidates";
import { datesBetween } from "@/lib/planner/dates";
import { summariseDays } from "@/lib/planner/generate";
import { groceryProgressFrom } from "@/lib/plan/phase";
import type { GroceryProgress } from "@/lib/plan/phase";
import type { Candidate, DayPersonSummary, PersonTarget, PlanInput, PlannedSlot, Slot } from "@/lib/planner/types";
import { getData, getDb } from "./context";
import { defaultViewQuery } from "./saved-views";

export type PersonRow = typeof s.people.$inferSelect;

export function proteinTargetOf(p: PersonRow): number {
  if (p.proteinTargetG) return p.proteinTargetG;
  return Math.round((p.proteinGPerKg ?? 1.2) * p.weightKg);
}

export function listPeople(): PersonRow[] {
  return getDb().select().from(s.people).orderBy(s.people.id).all();
}

export function getPerson(id: number): PersonRow | undefined {
  return getDb().select().from(s.people).where(eq(s.people.id, id)).get();
}

export function getPrefs(personId: number): { liked: string[]; avoided: string[] } {
  const rows = getDb()
    .select({ kind: s.preferences.kind, slug: s.ingredients.slug })
    .from(s.preferences)
    .innerJoin(s.ingredients, eq(s.ingredients.id, s.preferences.ingredientId))
    .where(eq(s.preferences.personId, personId))
    .all();
  return {
    liked: rows.filter((r) => r.kind === "like").map((r) => r.slug),
    avoided: rows.filter((r) => r.kind === "avoid").map((r) => r.slug),
  };
}

export function toPersonTarget(p: PersonRow): PersonTarget {
  const prefs = getPrefs(p.id);
  return {
    id: String(p.id),
    name: p.name,
    proteinTargetG: proteinTargetOf(p),
    kcalTarget: p.kcalTarget,
    liked: new Set(prefs.liked),
    avoided: new Set(prefs.avoided),
  };
}

export function feedbackMap(): Map<string, Feedback> {
  const rows = getDb()
    .select({
      slug: s.recipes.slug,
      favourite: s.recipeFeedback.favourite,
      banned: s.recipeFeedback.banned,
      rating: s.recipeFeedback.rating,
      status: s.recipeFeedback.status,
    })
    .from(s.recipeFeedback)
    .innerJoin(s.recipes, eq(s.recipes.id, s.recipeFeedback.recipeId))
    .all();
  return new Map(rows.map((r) => [r.slug, { favourite: r.favourite, banned: r.banned, rating: r.rating, tested: r.status === "tested" }]));
}

export function getCandidates(): Candidate[] {
  return buildCandidates(getData(), feedbackMap());
}

export function recipeIds(): { bySlug: Map<string, number>; byId: Map<number, string> } {
  const rows = getDb().select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes).all();
  return { bySlug: new Map(rows.map((r) => [r.slug, r.id])), byId: new Map(rows.map((r) => [r.id, r.slug])) };
}

export function ingredientIds(): { bySlug: Map<string, number>; byId: Map<number, string> } {
  const rows = getDb().select({ id: s.ingredients.id, slug: s.ingredients.slug }).from(s.ingredients).all();
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

export function latestPlanId(): number | undefined {
  return getDb().select({ id: s.plans.id }).from(s.plans).orderBy(desc(s.plans.id)).limit(1).get()?.id;
}

export function listPlans(limit = 10): { id: number; startDate: string; endDate: string; createdAt: string }[] {
  return getDb()
    .select({ id: s.plans.id, startDate: s.planSetups.startDate, endDate: s.planSetups.endDate, createdAt: s.plans.createdAt })
    .from(s.plans)
    .innerJoin(s.planSetups, eq(s.planSetups.id, s.plans.setupId))
    .orderBy(desc(s.plans.id))
    .limit(limit)
    .all();
}

export function getPlanView(planId: number, candidates: Candidate[] = getCandidates()): PlanView | undefined {
  const db = getDb();
  const row = db
    .select({ plan: s.plans, setup: s.planSetups })
    .from(s.plans)
    .innerJoin(s.planSetups, eq(s.planSetups.id, s.plans.setupId))
    .where(eq(s.plans.id, planId))
    .get();
  if (!row) return undefined;
  const people = row.setup.personIds.length
    ? db.select().from(s.people).where(inArray(s.people.id, row.setup.personIds)).orderBy(s.people.id).all()
    : [];
  const rid = recipeIds();
  const slotRows = db.select().from(s.planSlots).where(eq(s.planSlots.planId, planId)).orderBy(s.planSlots.date, s.planSlots.id).all();
  const portionRows = slotRows.length
    ? db.select().from(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slotRows.map((r) => r.id))).all()
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
  const targets = people.map(toPersonTarget);
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
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
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

export function lastSetup(): { personIds: number[]; mealTypes: Slot[]; cuisineBalance: number; maxActiveMin: number | null; days: number; healthFocus: { nutrientDense: boolean; lowSugar: boolean; light: boolean } | null; prepStyle: "variety" | "leftovers" | "batch" | null } | undefined {
  const r = getDb().select().from(s.planSetups).orderBy(desc(s.planSetups.id)).limit(1).get();
  if (!r) return undefined;
  const days = datesBetween(r.startDate, r.endDate).length;
  return { personIds: r.personIds, mealTypes: r.mealTypes as Slot[], cuisineBalance: r.cuisineBalance, maxActiveMin: r.maxActiveMin, days, healthFocus: r.healthFocus, prepStyle: r.prepStyle };
}

export function groceryChecks(planId: number): { checked: Set<string>; manual: { id: number; text: string; checked: boolean }[] } {
  const db = getDb();
  const ids = ingredientIds();
  const rows = db.select().from(s.groceryState).where(and(eq(s.groceryState.planId, planId), eq(s.groceryState.checked, true))).all();
  const manual = db.select().from(s.groceryManual).where(eq(s.groceryManual.planId, planId)).all();
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

export function getSavedViews(list: string): SavedView[] {
  return getDb().select({ id: s.savedViews.id, name: s.savedViews.name, query: s.savedViews.query, isDefault: s.savedViews.isDefault }).from(s.savedViews).where(eq(s.savedViews.list, list)).orderBy(s.savedViews.id).all();
}

/** The query string saved as this list's default view, or null. */
export function getDefaultViewQuery(list: string): string | null {
  return defaultViewQuery(getDb(), list);
}

/** Items left to buy for a whole plan, counted the way the Groceries page counts them. */
export function groceryProgress(view: PlanView): GroceryProgress {
  const data = getData();
  const meals = view.slots.map((sl) => ({ recipeSlug: sl.recipeSlug, servings: Object.values(sl.servings).reduce((a, b) => a + b, 0) }));
  return groceryProgressFrom(meals, data.recipes, data.ingredients, groceryChecks(view.id).checked);
}
