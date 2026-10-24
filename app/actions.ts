"use server";

import path from "node:path";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import * as s from "@/lib/db/schema";
import { FeedbackInput, writePersonalRecipeFeedback } from "@/lib/human/personal-feedback";
import type { LinkInput } from "@/lib/links/types";
import { loadCandidates } from "@/lib/photos/candidates";
import { approveCandidateChecked, rejectCandidateChecked } from "@/lib/server/photo-review";
import { addRecipePhotoChecked, makeCoverChecked, removePhotoChecked } from "@/lib/server/photo-actions";
import { addLinkChecked, moveLinkChecked, removeLinkChecked, updateLinkChecked } from "@/lib/server/link-actions";
import type { PartMode } from "@/lib/parts/mode";
import { datesBetween } from "@/lib/planner/dates";
import { computeFeasibility } from "@/lib/planner/feasibility";
import type { FeasibilityInput, FeasibilityResult, PlanStep } from "@/lib/planner/feasibility-types";
import { catalogByHabit, getRoutineCatalog } from "@/lib/routines/catalog";
import type { IsoWeekday, TimeOfDay } from "@/lib/routines/types";
import { planRoutineRowsFor, savePersonRoutine } from "@/lib/server/routine-state";
import { loadNight } from "@/lib/server/prep";
import { todayISO } from "@/lib/server/time";
import { generatePlan, portionsFor, slotShares, suggestSwaps } from "@/lib/planner/generate";
import type { GeneratedPlan, Slot } from "@/lib/planner/types";
import { MEAL_SLOTS, PlanSetupSchema } from "@/lib/schemas";
import { PersonInput, type PersonInputData } from "@/lib/schemas/person";
import { getData, getDb } from "@/lib/server/context";
import { getBlobStore } from "@/lib/blob";
import { photoWritesEnabled } from "@/lib/blob/config";
import { backupBeforeReset, CONFIRM_WORD, NEEDS_TYPED_CONFIRM, RESET_SCOPES, resetData } from "@/lib/server/reset";
import type { ResetScope } from "@/lib/server/reset";
import { writePartMode } from "@/lib/server/part-state";
import { writePlanStep } from "@/lib/server/plan-progress";
import { clearDefaultView as clearDefaultViewRow, setDefaultView, VIEW_LISTS } from "@/lib/server/saved-views";
import { getCandidates, getPlanView, ingredientIds, recipeIds, toPersonTarget } from "@/lib/server/queries";
import { actionDenial, requireMember } from "@/lib/auth/access";
import { manualItemExists, slotBelongsToPlan } from "@/lib/server/plan-access";
import { resolveOnlyHouseholdAccess, type HouseholdAccess } from "@/lib/auth/household-access";
import { HouseholdAccessError } from "@/lib/auth/household";
import {
  deleteHouseholdPerson, householdPeople, persistHouseholdPlan, saveHouseholdPerson, saveHouseholdPreferences,
  deleteHouseholdPlan, mutateHouseholdPlan, mutateHouseholdPerson, regenerateHouseholdPlan,
} from "@/lib/server/household-plans";
import type { Db } from "@/lib/db/client";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fields?: Record<string, string> };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

async function householdContext(): Promise<Result<{ db: Db; access: HouseholdAccess }>> {
  try {
    const member = await requireMember();
    const db = await getDb();
    return { ok: true, db, access: await resolveOnlyHouseholdAccess(db, member.userId) };
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}

async function planMutation<T = object>(
  planId: number, write: (db: Db, access: HouseholdAccess) => Promise<Result<NoInfer<T>>>,
): Promise<Result<T>> {
  if (!Number.isSafeInteger(planId) || planId <= 0) return fail("Plan not found.");
  const context = await householdContext();
  if (!context.ok) return context;
  const { db, access } = context;
  try {
    return await mutateHouseholdPlan(db, access, planId, (tx) => write(tx, access));
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}

function refresh(planId?: number) {
  revalidatePath("/", "layout");
  if (planId) revalidatePath(`/plan/${planId}`);
}

async function personMutation(personId: number, write: (db: Db) => Promise<Result>): Promise<Result> {
  const context = await householdContext();
  if (!context.ok) return context;
  try {
    return await mutateHouseholdPerson(context.db, context.access, personId, write);
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}

// ---------- Profiles ----------

export type { PersonInputData } from "@/lib/schemas/person";

export async function savePerson(input: PersonInputData): Promise<Result<{ id: number }>> {
  const denied = await actionDenial(input?.id === undefined ? "owner" : { personId: input.id });
  if (denied) return denied;
  const parsed = PersonInput.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!fields[key]) fields[key] = issue.message;
    }
    const count = Object.keys(fields).length;
    return { ok: false, error: count === 1 ? "Fix the field marked below." : `Fix the ${count} fields marked below.`, fields };
  }
  const db = await getDb();
  try {
    const member = await requireMember();
    const access = await resolveOnlyHouseholdAccess(db, member.userId);
    const saved = await saveHouseholdPerson(db, access, parsed.data);
    refresh();
    return { ok: true, ...saved };
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
}

export async function deletePerson(id: number): Promise<Result> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  const db = await getDb();
  try {
    const member = await requireMember();
    const access = await resolveOnlyHouseholdAccess(db, member.userId);
    await deleteHouseholdPerson(db, access, id);
  } catch (error) {
    if (error instanceof HouseholdAccessError) return fail(error.message);
    throw error;
  }
  refresh();
  return { ok: true };
}

// ---------- Plan creation ----------

const CreatePlanInput = z.object({
  personIds: z.array(z.number().int().positive()).min(1, "Choose at least one person"),
  startDate: z.string(),
  endDate: z.string(),
  mealTypes: z.array(z.enum(MEAL_SLOTS)).min(1, "Choose at least one meal type"),
  cuisineBalance: z.number().min(0).max(1),
  maxActiveMin: z.number().int().positive().nullable(),
  pinned: z.array(z.string()),
  healthFocus: z.object({ nutrientDense: z.boolean(), lowSugar: z.boolean(), light: z.boolean() }).default({ nutrientDense: true, lowSugar: true, light: true }),
  prepStyle: z.enum(["variety", "leftovers", "batch"]).default("leftovers"),
  prefs: z.record(z.string(), z.object({ liked: z.array(z.string()), avoided: z.array(z.string()) })),
  /** ISO weekdays (1 = Monday ... 7 = Sunday): when to finish shopping and when to batch cook. Optional. */
  shoppingDay: z.number().int().min(1, "Choose a day from Monday to Sunday").max(7, "Choose a day from Monday to Sunday").nullable().optional(),
  prepDay: z.number().int().min(1, "Choose a day from Monday to Sunday").max(7, "Choose a day from Monday to Sunday").nullable().optional(),
});

export type CreatePlanData = z.input<typeof CreatePlanInput>;

async function savePrefs(db: Db, access: HouseholdAccess, personId: number, liked: string[], avoided: string[]) {
  const ids = await ingredientIds();
  const rows = [
    ...liked.filter((l) => !avoided.includes(l)).map((slug) => ({ personId, ingredientId: ids.bySlug.get(slug), kind: "like" as const })),
    ...avoided.map((slug) => ({ personId, ingredientId: ids.bySlug.get(slug), kind: "avoid" as const })),
  ].filter((r) => r.ingredientId !== undefined);
  await saveHouseholdPreferences(db, access, personId, rows.map((r) => ({ ingredientId: r.ingredientId!, kind: r.kind })));
}

export async function createPlan(input: CreatePlanData): Promise<Result<{ planId: number; gaps: number }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  const parsed = CreatePlanInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the plan setup");
  const v = parsed.data;

  const setupCheck = PlanSetupSchema.safeParse({
    person_ids: v.personIds.map(String),
    start_date: v.startDate,
    end_date: v.endDate,
    meal_types: v.mealTypes,
    cuisine_balance: v.cuisineBalance,
    max_active_min: v.maxActiveMin ?? undefined,
    pinned_recipes: v.pinned,
    shopping_day: v.shoppingDay ?? null,
    prep_day: v.prepDay ?? null,
  });
  if (!setupCheck.success) return fail(setupCheck.error.issues[0]?.message ?? "Check the dates");

  const context = await householdContext();
  if (!context.ok) return context;
  const { db, access } = context;
  const people = (await householdPeople(db, access)).filter((person) => v.personIds.includes(person.id));
  if (people.length !== v.personIds.length) return fail("One of the selected profiles no longer exists");
  if (access.role !== "owner" && people.some((person) => person.id !== access.personId && v.prefs[String(person.id)] !== undefined)) {
    return fail("You can only change your own ingredient preferences.");
  }
  for (const p of people) {
    const pref = v.prefs[String(p.id)];
    if (pref) await savePrefs(db, access, p.id, pref.liked, pref.avoided);
  }

  const dates = datesBetween(v.startDate, v.endDate);
  const targets = await Promise.all(people.map(toPersonTarget));
  const seed = Math.floor(Math.random() * 2 ** 31);
  const candidates = await getCandidates(v.personIds);
  const plan = generatePlan(
    { dates, mealTypes: v.mealTypes as Slot[], people: targets, cuisineBalance: v.cuisineBalance, maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle, pinnedRecipes: v.pinned, locked: [], seed },
    candidates,
  );
  if (plan.slots.length === 0) return fail("No recipes match these choices. Remove an avoided ingredient or relax the time limit.");

  const now = new Date().toISOString();
  // Routine choices of the people in the plan are copied into the plan, so its groceries and prep stay stable if a choice changes later.
  const routineRows = await planRoutineRowsFor(db, v.personIds, v.startDate, v.endDate, 0);
  const planId = await persistHouseholdPlan(db, access, {
    setup: { personIds: v.personIds, startDate: v.startDate, endDate: v.endDate, mealTypes: v.mealTypes, cuisineBalance: v.cuisineBalance, maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle, shoppingDay: v.shoppingDay ?? null, prepDay: v.prepDay ?? null, createdAt: now },
    seed, slots: plan.slots, routines: routineRows, recipeIds: (await recipeIds()).bySlug,
  });
  refresh(planId);
  return { ok: true, planId, gaps: plan.warnings.filter((w) => w.type === "protein_gap").length };
}

/**
 * What the Review step shows: how many recipes pass the choices so far and whether each person's protein target can be
 * reached. Reads only; nothing is saved, including the likes and avoids in `prefs`.
 */
export async function previewFeasibility(input: FeasibilityInput): Promise<Result<{ result: FeasibilityResult }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  const parsed = CreatePlanInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the plan setup");
  const v = parsed.data;
  const setupCheck = PlanSetupSchema.safeParse({
    person_ids: v.personIds.map(String),
    start_date: v.startDate,
    end_date: v.endDate,
    meal_types: v.mealTypes,
    cuisine_balance: v.cuisineBalance,
    max_active_min: v.maxActiveMin ?? undefined,
    pinned_recipes: v.pinned,
  });
  if (!setupCheck.success) return fail(setupCheck.error.issues[0]?.message ?? "Check the dates");

  const context = await householdContext();
  if (!context.ok) return context;
  const { db, access } = context;
  const people = (await householdPeople(db, access)).filter((person) => v.personIds.includes(person.id));
  if (people.length !== v.personIds.length) return fail("One of the selected profiles no longer exists");
  // The choices on screen win over what is saved, so the preview follows them before anything is stored.
  const targets = (await Promise.all(people.map(toPersonTarget))).map((t) => {
    const pref = v.prefs[t.id];
    return pref ? { ...t, liked: new Set(pref.liked.filter((l) => !pref.avoided.includes(l))), avoided: new Set(pref.avoided) } : t;
  });
  const result = computeFeasibility({ ...v, mealTypes: v.mealTypes as FeasibilityInput["mealTypes"] }, await getCandidates(v.personIds), targets);
  return { ok: true, result };
}

/** Marks one of the three after-plan steps (reviewed, shopping, prep) done. Doing it again changes nothing. */
export async function markPlanStep(planId: number, step: PlanStep): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const written = await planMutation(planId, (db) => writePlanStep(db, planId, step));
  if (!written.ok) return fail(written.error);
  refresh(planId);
  return { ok: true };
}

// ---------- Plan editing ----------

export async function regeneratePlan(planId: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const view = await getPlanView(planId);
  if (!view) return fail("Plan not found");
  const seed = Math.floor(Math.random() * 2 ** 31);
  const plan = generatePlan({ ...view.input, seed }, await getCandidates(view.people.map((p) => p.id)));
  const ids = (await recipeIds()).bySlug;
  const written = await planMutation(planId, async (db, access) => {
    await regenerateHouseholdPlan(db, access, planId, seed, plan.slots, ids);
    return { ok: true };
  });
  if (written.ok) refresh(planId);
  return written;
}

export async function toggleLock(planId: number, slotId: number, locked: boolean): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const written = await planMutation(planId, async (db) => {
    if (!(await slotBelongsToPlan(db, planId, slotId))) return fail("Meal not found in this plan.");
    await db.update(s.planSlots).set({ locked }).where(and(eq(s.planSlots.id, slotId), eq(s.planSlots.planId, planId)));
    return { ok: true };
  });
  if (written.ok) refresh(planId);
  return written;
}

export interface SwapOption {
  slug: string;
  name: string;
  proteinG: number;
  kcal: number;
  activeMin: number;
  reason: string;
}

export async function getSwapOptions(planId: number, slotId: number): Promise<Result<{ options: SwapOption[]; current: string }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  const view = await getPlanView(planId);
  const slot = view?.slots.find((x) => x.id === slotId);
  if (!view || !slot) return fail("Meal not found");
  const candidates = await getCandidates(view.people.map((p) => p.id));
  const generated: GeneratedPlan = { slots: view.slots, days: view.days, warnings: [] };
  const options = suggestSwaps(generated, { date: slot.date, slot: slot.slot }, view.input, candidates, 3).map((c) => {
    const liked = view.input.people.some((p) => [...p.liked].some((l) => c.ingredients.has(l)));
    return {
      slug: c.slug,
      name: c.name,
      proteinG: Math.round(c.perServing.protein_g * 10) / 10,
      kcal: Math.round(c.perServing.kcal),
      activeMin: c.activeMin,
      reason: liked ? "Uses an ingredient you like" : `${c.activeMin} min of work`,
    };
  });
  return { ok: true, options, current: slot.recipeSlug };
}

export async function swapSlot(planId: number, slotId: number, recipeSlug: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const view = await getPlanView(planId);
  const slot = view?.slots.find((x) => x.id === slotId);
  const candidate = view && (await getCandidates(view.people.map((p) => p.id))).find((c) => c.slug === recipeSlug);
  if (!view || !slot || !candidate) return fail("Could not swap that meal");
  const rid = await recipeIds();
  const recipeId = rid.bySlug.get(recipeSlug);
  if (recipeId === undefined) return fail("Recipe not found");
  const shares = slotShares(view.mealTypes);
  const portions = portionsFor(candidate, view.input.people, shares[slot.slot] ?? 0.25);
  const written = await planMutation(planId, async (tx) => {
    if (!(await slotBelongsToPlan(tx, planId, slotId))) return fail("Meal not found in this plan.");
    // A swapped meal is cooked fresh, so it is no longer a leftover.
    await tx.update(s.planSlots).set({ recipeId, isLeftover: false }).where(and(eq(s.planSlots.id, slotId), eq(s.planSlots.planId, planId)));
    await tx.delete(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, slotId));
    for (const [pid, servings] of Object.entries(portions)) await tx.insert(s.planSlotPortions).values({ planSlotId: slotId, personId: Number(pid), servings });
    return { ok: true };
  });
  if (written.ok) refresh(planId);
  return written;
}

export async function setPortion(planId: number, slotId: number, personId: number, servings: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!Number.isFinite(servings) || !(servings >= 0.25 && servings <= 4)) return fail("Servings must be between 0.25 and 4");
  const q = Math.round(servings * 4) / 4;
  const written = await planMutation(planId, async (db) => {
    if (!(await slotBelongsToPlan(db, planId, slotId, personId))) return fail("That portion is not part of this plan.");
    await db.update(s.planSlotPortions).set({ servings: q })
      .where(and(eq(s.planSlotPortions.planSlotId, slotId), eq(s.planSlotPortions.personId, personId)));
    return { ok: true };
  });
  if (written.ok) refresh(planId);
  return written;
}

export async function deletePlan(planId: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const written = await planMutation(planId, async (db, access) => {
    await deleteHouseholdPlan(db, access, planId);
    return { ok: true };
  });
  if (written.ok) refresh();
  return written;
}

// ---------- Recipes ----------

export async function setRecipeFeedback(
  slug: string,
  patch: { favourite?: boolean; banned?: boolean; rating?: number | null; tested?: boolean; notes?: string | null },
): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const parsed = FeedbackInput.safeParse(patch);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check your recipe feedback.");
  const member = await requireMember();
  const id = (await recipeIds()).bySlug.get(slug);
  if (id === undefined) return fail("Recipe not found");
  // The write path for human-owned data lives in lib/human; this action only validates and refreshes.
  await writePersonalRecipeFeedback(await getDb(), member.personId, id, parsed.data);
  refresh();
  return { ok: true };
}

// ---------- Photos ----------

/** Adds a photo the person took to a recipe. The phone has already resized it; the server checks and re-encodes it. */
export async function uploadRecipePhoto(formData: FormData): Promise<Result<{ uid: string }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoWritesEnabled()) return fail("Photo changes are disabled in preview deployments.");
  const slug = formData.get("recipe");
  const file = formData.get("photo");
  if (typeof slug !== "string" || !(file instanceof File)) return fail("Choose a photo first.");
  const result = await addRecipePhotoChecked(await getDb(), getBlobStore(), { recipeSlug: slug, bytes: new Uint8Array(await file.arrayBuffer()) });
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true, uid: result.uid };
}

/** Approves a candidate photo. Only the subject and the candidate key come from the page; everything else is read on the server. */
export async function approvePhotoCandidate(kind: "recipe" | "ingredient", slug: string, key: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoWritesEnabled()) return fail("Photo changes are disabled in preview deployments.");
  if (kind !== "recipe" && kind !== "ingredient") return fail("Unknown kind");
  const r = await approveCandidateChecked(await getDb(), getBlobStore(), loadCandidates(process.cwd()), { kind, slug, key });
  if (!r.ok) return r;
  revalidatePath("/photos/review");
  revalidatePath("/credits");
  if (r.recipeSlug) refreshRecipe(r.recipeSlug);
  else revalidatePath("/ingredients", "layout");
  return { ok: true };
}

export async function rejectPhotoCandidate(kind: "recipe" | "ingredient", slug: string, key: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoWritesEnabled()) return fail("Photo changes are disabled in preview deployments.");
  if (kind !== "recipe" && kind !== "ingredient") return fail("Unknown kind");
  const r = await rejectCandidateChecked(await getDb(), loadCandidates(process.cwd()), { kind, slug, key });
  if (!r.ok) return r;
  revalidatePath("/photos/review");
  return { ok: true };
}

export async function removePhoto(uid: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoWritesEnabled()) return fail("Photo changes are disabled in preview deployments.");
  const result = await removePhotoChecked(await getDb(), getBlobStore(), uid);
  if (!result.ok) return result;
  if (result.recipeSlug) refreshRecipe(result.recipeSlug);
  return { ok: true };
}

export async function makeCoverPhoto(uid: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoWritesEnabled()) return fail("Photo changes are disabled in preview deployments.");
  const result = await makeCoverChecked(await getDb(), uid);
  if (!result.ok) return result;
  if (result.recipeSlug) refreshRecipe(result.recipeSlug);
  return { ok: true };
}

// ---------- Groceries ----------

export async function setGroceryChecked(planId: number, ingredientSlug: string, checked: boolean): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const ingredientId = (await ingredientIds()).bySlug.get(ingredientSlug);
  if (ingredientId === undefined) return fail("Unknown ingredient");
  return planMutation(planId, async (db) => {
    await db.insert(s.groceryState).values({ planId, ingredientId, checked })
      .onConflictDoUpdate({ target: [s.groceryState.planId, s.groceryState.ingredientId], set: { checked } });
    return { ok: true };
  });
}

export async function addManualItem(planId: number, text: string): Promise<Result<{ id: number }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  const t = text.trim();
  if (!t) return fail("Type an item first");
  if (t.length > 120) return fail("That is too long");
  const written = await planMutation<{ id: number }>(planId, async (db) => {
    const [row] = await db.insert(s.groceryManual).values({ planId, text: t, checked: false }).returning({ id: s.groceryManual.id });
    return { ok: true, id: row!.id };
  });
  if (written.ok) revalidatePath("/groceries");
  return written;
}

export async function setManualChecked(id: number, checked: boolean): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!Number.isSafeInteger(id) || id <= 0) return fail("Shopping item not found.");
  const [item] = await (await getDb()).select({ planId: s.groceryManual.planId }).from(s.groceryManual).where(eq(s.groceryManual.id, id));
  if (!item) return fail("Shopping item not found.");
  return planMutation(item.planId, async (db) => {
    if (!(await manualItemExists(db, id))) return fail("Shopping item not found.");
    await db.update(s.groceryManual).set({ checked }).where(and(eq(s.groceryManual.id, id), eq(s.groceryManual.planId, item.planId)));
    return { ok: true };
  });
}

export async function removeManualItem(id: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!Number.isSafeInteger(id) || id <= 0) return fail("Shopping item not found.");
  const [item] = await (await getDb()).select({ planId: s.groceryManual.planId }).from(s.groceryManual).where(eq(s.groceryManual.id, id));
  if (!item) return fail("Shopping item not found.");
  const written = await planMutation(item.planId, async (db) => {
    if (!(await manualItemExists(db, id))) return fail("Shopping item not found.");
    await db.delete(s.groceryManual).where(and(eq(s.groceryManual.id, id), eq(s.groceryManual.planId, item.planId)));
    return { ok: true };
  });
  if (written.ok) revalidatePath("/groceries");
  return written;
}

// ---------- Today card ----------

export async function setHabitDone(date: string, personId: number, habitSlug: string, done: boolean): Promise<Result> {
  const denied = await actionDenial({ personId });
  if (denied) return denied;
  return personMutation(personId, async (db) => {
    const [habit] = await db.select({ id: s.habits.id }).from(s.habits).where(eq(s.habits.slug, habitSlug)).limit(1);
    if (!habit) return fail("Unknown habit");
    await db.insert(s.habitLog).values({ date, personId, habitId: habit.id, done })
      .onConflictDoUpdate({ target: [s.habitLog.date, s.habitLog.personId, s.habitLog.habitId], set: { done } });
    return { ok: true };
  });
}

export async function setPrepDone(date: string, taskKey: string, done: boolean): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const match = /^(?:night|prep):([1-9]\d*):/.exec(taskKey);
  if (!match || taskKey.length > 256) return fail("Prep task not found in this plan.");
  const planId = Number(match[1]);
  const view = await getPlanView(planId);
  if (!view) return fail("Plan not found.");
  const night = await loadNight(view, todayISO());
  const task = night.tasks.find((t) => t.key === taskKey);
  const session = night.guide.sessions.find((se) => se.events.some((event) => `prep:${planId}:${event.id}` === taskKey));
  if (!task && !session) return fail("Prep task not found in this plan.");
  date = task?.dueDate ?? session!.date;
  return planMutation(planId, async (db, access) => {
    const saved = await db.insert(s.prepTaskState).values({ householdId: access.householdId, date, taskKey, done })
      .onConflictDoUpdate({
        target: [s.prepTaskState.date, s.prepTaskState.taskKey], set: { done },
        setWhere: eq(s.prepTaskState.householdId, access.householdId),
      }).returning({ key: s.prepTaskState.taskKey });
    if (saved.length === 0) return fail("Prep task ownership conflicts with this household.");
    return { ok: true };
  });
}

export async function enableShake(planId: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const view = await getPlanView(planId);
  if (!view) return fail("Plan not found");
  if (view.mealTypes.includes("shake")) return { ok: true };
  const mealTypes: Slot[] = [...view.mealTypes, "shake"];
  const seed = Math.floor(Math.random() * 2 ** 31);
  const plan = generatePlan({ ...view.input, mealTypes, seed }, await getCandidates(view.people.map((p) => p.id)));
  const ids = (await recipeIds()).bySlug;
  const written = await planMutation(planId, async (db, access) => {
    await db.update(s.planSetups).set({ mealTypes }).where(eq(s.planSetups.id, view.setupId));
    await regenerateHouseholdPlan(db, access, planId, seed, plan.slots, ids);
    return { ok: true };
  });
  if (written.ok) refresh(planId);
  return written;
}

// ---------- Settings: reset ----------

/** Deletes user data for one scope after backing the database up. Content under /data is never touched. */
export async function resetScope(scope: string, typed: string): Promise<Result<{ backup: string | null }>> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!(RESET_SCOPES as readonly string[]).includes(scope)) return fail("Unknown reset option");
  const sc = scope as ResetScope;
  if (NEEDS_TYPED_CONFIRM.includes(sc) && typed.trim() !== CONFIRM_WORD) return fail(`Type ${CONFIRM_WORD} to confirm`);
  try {
    const backup = await backupBeforeReset();
    await resetData(await getDb(), sc, getBlobStore());
    refresh();
    return { ok: true, backup: backup ? path.relative(process.cwd(), backup) : null };
  } catch (e) {
    return fail(`Reset failed and nothing was changed: ${(e as Error).message}`);
  }
}

// ---------- Saved list views ----------

const ViewInput = z.object({
  list: z.enum(VIEW_LISTS),
  // A URL query string of our own making: letters, digits and the few separators the filter system writes.
  query: z.string().max(500).regex(/^[A-Za-z0-9_=&,.\-+%]*$/, "That view cannot be saved"),
});

/** Makes this query the list's default view. Replaces the previous default for the list. */
export async function saveDefaultView(list: string, query: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const parsed = ViewInput.safeParse({ list, query });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That view cannot be saved");
  await setDefaultView(await getDb(), parsed.data.list, parsed.data.query);
  revalidatePath(`/${parsed.data.list}`);
  return { ok: true };
}

export async function clearDefaultView(list: string): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const parsed = ViewInput.shape.list.safeParse(list);
  if (!parsed.success) return fail("Unknown list");
  await clearDefaultViewRow(await getDb(), parsed.data);
  revalidatePath(`/${parsed.data}`);
  return { ok: true };
}

// ---------- Parts of a meal ----------

/**
 * Chooses how a part of a meal (a component such as hummus) is provided for one plan: make it, buy it ready-made, or
 * already have it. "Make" is the default, so choosing it removes the row. Groceries, the prep guide and the reminders
 * read this.
 */
export async function setPartMode(planId: number, componentSlug: string, mode: PartMode): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const written = await planMutation(planId, (db) => writePartMode(db, getData().recipes, planId, componentSlug, mode));
  if (!written.ok) return fail(written.error);
  revalidatePath(`/plan/${planId}/prep`);
  revalidatePath("/groceries");
  refresh(planId);
  return { ok: true };
}

// ---------- Recipe links ----------

function refreshRecipe(slug: string) {
  revalidatePath(`/recipes/${slug}`);
  revalidatePath(`/recipes/${slug}/cook`);
}

/** Saves a link to a recipe page, video or article on a recipe or one of its parts. Human-owned data. */
export async function addLink(input: LinkInput): Promise<Result<{ id: number }>> {
  const denied = await actionDenial();
  if (denied) return denied;
  const result = await addLinkChecked(await getDb(), getData().recipes, input);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true, id: result.id };
}

export async function updateLink(id: number, input: LinkInput): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const result = await updateLinkChecked(await getDb(), getData().recipes, id, input);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true };
}

export async function removeLink(id: number): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  const result = await removeLinkChecked(await getDb(), id);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true };
}

export async function moveLink(id: number, direction: "up" | "down"): Promise<Result> {
  const denied = await actionDenial();
  if (denied) return denied;
  if (direction !== "up" && direction !== "down") return fail("Direction must be up or down");
  const result = await moveLinkChecked(await getDb(), id, direction);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true };
}

// ---------- Routines ----------

/**
 * Saves one person's choice of a daily routine (methi water, soaked almonds): on or off, which days, when in the day, how
 * many servings. Anything not given keeps the person's earlier choice, then the routine's defaults. The choice is copied
 * into each plan when the plan is made, so changing it affects the next plan, not one already made.
 */
export async function setPersonRoutine(
  personId: number,
  habitSlug: string,
  patch: { active: boolean; days?: IsoWeekday[]; timeOfDay?: TimeOfDay; servings?: number },
): Promise<Result> {
  const denied = await actionDenial({ personId });
  if (denied) return denied;
  const catalog = catalogByHabit(getRoutineCatalog(getData()));
  const res = await personMutation(personId, (db) => savePersonRoutine(db, catalog, personId, habitSlug, patch));
  if (!res.ok) return fail(res.error);
  revalidatePath(`/profiles/${personId}`);
  revalidatePath("/profiles");
  return { ok: true };
}
