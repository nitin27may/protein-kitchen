"use server";

import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import * as s from "@/lib/db/schema";
import { withTx } from "@/lib/db/tx";
import { writeRecipeFeedback } from "@/lib/human/feedback";
import type { LinkInput } from "@/lib/links/types";
import { addLinkChecked, moveLinkChecked, removeLinkChecked, updateLinkChecked } from "@/lib/server/link-actions";
import type { PartMode } from "@/lib/parts/mode";
import { datesBetween } from "@/lib/planner/dates";
import { catalogByHabit, getRoutineCatalog } from "@/lib/routines/catalog";
import type { IsoWeekday, TimeOfDay } from "@/lib/routines/types";
import { planRoutineRowsFor, savePersonRoutine } from "@/lib/server/routine-state";
import { dueDateOfKey } from "@/lib/prep/night";
import { generatePlan, portionsFor, slotShares, suggestSwaps } from "@/lib/planner/generate";
import type { GeneratedPlan, PlannedSlot, Slot } from "@/lib/planner/types";
import { ACTIVITY_LEVELS, MEAL_SLOTS, PlanSetupSchema, SEXES } from "@/lib/schemas";
import { getData, getDb, getSqlite } from "@/lib/server/context";
import { backupBeforeReset, CONFIRM_WORD, NEEDS_TYPED_CONFIRM, RESET_SCOPES, resetData } from "@/lib/server/reset";
import type { ResetScope } from "@/lib/server/reset";
import { writePartMode } from "@/lib/server/part-state";
import { clearDefaultView as clearDefaultViewRow, setDefaultView, VIEW_LISTS } from "@/lib/server/saved-views";
import { getCandidates, getPlanView, ingredientIds, recipeIds, toPersonTarget } from "@/lib/server/queries";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fields?: Record<string, string> };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function refresh(planId?: number) {
  revalidatePath("/", "layout");
  if (planId) revalidatePath(`/plan/${planId}`);
}

// ---------- Profiles ----------

const PersonInput = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1, "Enter a name").max(60),
    sex: z.enum(SEXES),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a birth date"),
    heightCm: z.number({ invalid_type_error: "Enter a height", required_error: "Enter a height" }).min(100, "Height looks too small").max(250, "Height looks too large"),
    weightKg: z.number({ invalid_type_error: "Enter a weight", required_error: "Enter a weight" }).min(30, "Weight looks too small").max(300, "Weight looks too large"),
    activityLevel: z.enum(ACTIVITY_LEVELS),
    proteinMode: z.enum(["per_kg", "fixed"]),
    proteinValue: z.number({ invalid_type_error: "Enter a protein target", required_error: "Enter a protein target" }).positive("Enter a protein target"),
    kcalTarget: z.number().min(1000, "Calories look too low").max(6000, "Calories look too high").nullable(),
    reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").nullable(),
  })
  .refine((v) => v.proteinMode !== "per_kg" || (v.proteinValue >= 0.6 && v.proteinValue <= 3), {
    message: "Grams per kg should be between 0.6 and 3",
    path: ["proteinValue"],
  })
  .refine((v) => v.proteinMode !== "fixed" || (v.proteinValue >= 30 && v.proteinValue <= 400), {
    message: "Daily grams should be between 30 and 400",
    path: ["proteinValue"],
  });

export type PersonInputData = z.input<typeof PersonInput>;

export async function savePerson(input: PersonInputData): Promise<Result<{ id: number }>> {
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
  const v = parsed.data;
  const row = {
    name: v.name,
    sex: v.sex,
    birthDate: v.birthDate,
    heightCm: v.heightCm,
    weightKg: v.weightKg,
    activityLevel: v.activityLevel,
    proteinTargetG: v.proteinMode === "fixed" ? v.proteinValue : null,
    proteinGPerKg: v.proteinMode === "per_kg" ? v.proteinValue : null,
    kcalTarget: v.kcalTarget,
    reminderTime: v.reminderTime,
    dietFlags: [] as string[],
  };
  const db = await getDb();
  if (v.id) {
    await db.update(s.people).set(row).where(eq(s.people.id, v.id));
    refresh();
    return { ok: true, id: v.id };
  }
  const [created] = await db.insert(s.people).values(row).returning({ id: s.people.id });
  refresh();
  return { ok: true, id: created!.id };
}

export async function deletePerson(id: number): Promise<Result> {
  const db = await getDb();
  const [used] = await db.select({ id: s.planSlotPortions.planSlotId }).from(s.planSlotPortions).where(eq(s.planSlotPortions.personId, id)).limit(1);
  if (used) return fail("This profile is part of a saved plan. Delete those plans first.");
  await db.delete(s.people).where(eq(s.people.id, id));
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
});

export type CreatePlanData = z.input<typeof CreatePlanInput>;

async function savePrefs(personId: number, liked: string[], avoided: string[]) {
  const db = await getDb();
  const ids = await ingredientIds();
  await db.delete(s.preferences).where(and(eq(s.preferences.personId, personId), inArray(s.preferences.kind, ["like", "avoid"])));
  const rows = [
    ...liked.filter((l) => !avoided.includes(l)).map((slug) => ({ personId, ingredientId: ids.bySlug.get(slug), kind: "like" as const })),
    ...avoided.map((slug) => ({ personId, ingredientId: ids.bySlug.get(slug), kind: "avoid" as const })),
  ].filter((r) => r.ingredientId !== undefined);
  for (const r of rows) await db.insert(s.preferences).values({ personId, ingredientId: r.ingredientId!, kind: r.kind });
}

async function persistSlots(planId: number, slots: readonly PlannedSlot[]) {
  const db = await getDb();
  const rid = await recipeIds();
  for (const sl of slots) {
    const recipeId = rid.bySlug.get(sl.recipeSlug);
    if (recipeId === undefined) continue;
    const [row] = await db.insert(s.planSlots).values({ planId, date: sl.date, slot: sl.slot, recipeId, locked: sl.locked, isLeftover: sl.isLeftover ?? false }).returning({ id: s.planSlots.id });
    for (const [pid, servings] of Object.entries(sl.servings)) {
      await db.insert(s.planSlotPortions).values({ planSlotId: row!.id, personId: Number(pid), servings });
    }
  }
}

export async function createPlan(input: CreatePlanData): Promise<Result<{ planId: number; gaps: number }>> {
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

  const db = await getDb();
  const people = await db.select().from(s.people).where(inArray(s.people.id, v.personIds));
  if (people.length !== v.personIds.length) return fail("One of the selected profiles no longer exists");
  for (const p of people) {
    const pref = v.prefs[String(p.id)];
    if (pref) await savePrefs(p.id, pref.liked, pref.avoided);
  }

  const dates = datesBetween(v.startDate, v.endDate);
  const targets = await Promise.all(people.map(toPersonTarget));
  const seed = Math.floor(Math.random() * 2 ** 31);
  const candidates = await getCandidates();
  const plan = generatePlan(
    { dates, mealTypes: v.mealTypes as Slot[], people: targets, cuisineBalance: v.cuisineBalance, maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle, pinnedRecipes: v.pinned, locked: [], seed },
    candidates,
  );
  if (plan.slots.length === 0) return fail("No recipes match these choices. Remove an avoided ingredient or relax the time limit.");

  const now = new Date().toISOString();
  // Routine choices of the people in the plan are copied into the plan, so its groceries and prep stay stable if a choice changes later.
  const routineRows = await planRoutineRowsFor(db, v.personIds, v.startDate, v.endDate, 0);
  const planId = await withTx(db, (tx) => {
    const setup = tx
      .insert(s.planSetups)
      .values({ personIds: v.personIds, startDate: v.startDate, endDate: v.endDate, mealTypes: v.mealTypes, cuisineBalance: v.cuisineBalance, maxActiveMin: v.maxActiveMin, healthFocus: v.healthFocus, prepStyle: v.prepStyle, createdAt: now })
      .returning({ id: s.planSetups.id })
      .get();
    const created = tx.insert(s.plans).values({ setupId: setup.id, seed, createdAt: now }).returning({ id: s.plans.id }).get();
    for (const row of routineRows) tx.insert(s.planRoutines).values({ ...row, planId: created.id }).run();
    return created.id;
  });
  await persistSlots(planId, plan.slots);
  refresh(planId);
  return { ok: true, planId, gaps: plan.warnings.filter((w) => w.type === "protein_gap").length };
}

// ---------- Plan editing ----------

export async function regeneratePlan(planId: number): Promise<Result> {
  const view = await getPlanView(planId);
  if (!view) return fail("Plan not found");
  const seed = Math.floor(Math.random() * 2 ** 31);
  const plan = generatePlan({ ...view.input, seed }, await getCandidates());
  const db = await getDb();
  await db.delete(s.planSlots).where(and(eq(s.planSlots.planId, planId), eq(s.planSlots.locked, false)));
  await persistSlots(planId, plan.slots.filter((x) => !x.locked));
  await db.update(s.plans).set({ seed }).where(eq(s.plans.id, planId));
  refresh(planId);
  return { ok: true };
}

export async function toggleLock(planId: number, slotId: number, locked: boolean): Promise<Result> {
  await (await getDb()).update(s.planSlots).set({ locked }).where(and(eq(s.planSlots.id, slotId), eq(s.planSlots.planId, planId)));
  refresh(planId);
  return { ok: true };
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
  const view = await getPlanView(planId);
  const slot = view?.slots.find((x) => x.id === slotId);
  if (!view || !slot) return fail("Meal not found");
  const candidates = await getCandidates();
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
  const view = await getPlanView(planId);
  const slot = view?.slots.find((x) => x.id === slotId);
  const candidate = (await getCandidates()).find((c) => c.slug === recipeSlug);
  if (!view || !slot || !candidate) return fail("Could not swap that meal");
  const rid = await recipeIds();
  const recipeId = rid.bySlug.get(recipeSlug);
  if (recipeId === undefined) return fail("Recipe not found");
  const shares = slotShares(view.mealTypes);
  const portions = portionsFor(candidate, view.input.people, shares[slot.slot] ?? 0.25);
  const db = await getDb();
  await withTx(db, (tx) => {
    // A swapped meal is cooked fresh, so it is no longer a leftover.
    tx.update(s.planSlots).set({ recipeId, isLeftover: false }).where(eq(s.planSlots.id, slotId)).run();
    tx.delete(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, slotId)).run();
    for (const [pid, servings] of Object.entries(portions)) tx.insert(s.planSlotPortions).values({ planSlotId: slotId, personId: Number(pid), servings }).run();
  });
  refresh(planId);
  return { ok: true };
}

export async function setPortion(planId: number, slotId: number, personId: number, servings: number): Promise<Result> {
  if (!(servings >= 0.25 && servings <= 4)) return fail("Servings must be between 0.25 and 4");
  const q = Math.round(servings * 4) / 4;
  await (await getDb())
    .update(s.planSlotPortions)
    .set({ servings: q })
    .where(and(eq(s.planSlotPortions.planSlotId, slotId), eq(s.planSlotPortions.personId, personId)));
  refresh(planId);
  return { ok: true };
}

export async function deletePlan(planId: number): Promise<Result> {
  const db = await getDb();
  const [row] = await db.select({ setupId: s.plans.setupId }).from(s.plans).where(eq(s.plans.id, planId)).limit(1);
  await db.delete(s.plans).where(eq(s.plans.id, planId));
  if (row) await db.delete(s.planSetups).where(eq(s.planSetups.id, row.setupId));
  refresh();
  return { ok: true };
}

// ---------- Recipes ----------

export async function setRecipeFeedback(
  slug: string,
  patch: { favourite?: boolean; banned?: boolean; rating?: number | null; tested?: boolean; notes?: string | null },
): Promise<Result> {
  const id = (await recipeIds()).bySlug.get(slug);
  if (id === undefined) return fail("Recipe not found");
  if (patch.rating !== undefined && patch.rating !== null && (patch.rating < 1 || patch.rating > 5)) return fail("Rating is 1 to 5");
  if (patch.notes !== undefined && patch.notes !== null && patch.notes.length > 2000) return fail("Notes are too long");
  // The write path for human-owned data lives in lib/human; this action only validates and refreshes.
  await writeRecipeFeedback(await getDb(), id, patch);
  refresh();
  return { ok: true };
}

// ---------- Groceries ----------

export async function setGroceryChecked(planId: number, ingredientSlug: string, checked: boolean): Promise<Result> {
  const ingredientId = (await ingredientIds()).bySlug.get(ingredientSlug);
  if (ingredientId === undefined) return fail("Unknown ingredient");
  await (await getDb())
    .insert(s.groceryState)
    .values({ planId, ingredientId, checked })
    .onConflictDoUpdate({ target: [s.groceryState.planId, s.groceryState.ingredientId], set: { checked } });
  return { ok: true };
}

export async function addManualItem(planId: number, text: string): Promise<Result<{ id: number }>> {
  const t = text.trim();
  if (!t) return fail("Type an item first");
  if (t.length > 120) return fail("That is too long");
  const [row] = await (await getDb()).insert(s.groceryManual).values({ planId, text: t, checked: false }).returning({ id: s.groceryManual.id });
  revalidatePath("/groceries");
  return { ok: true, id: row!.id };
}

export async function setManualChecked(id: number, checked: boolean): Promise<Result> {
  await (await getDb()).update(s.groceryManual).set({ checked }).where(eq(s.groceryManual.id, id));
  return { ok: true };
}

export async function removeManualItem(id: number): Promise<Result> {
  await (await getDb()).delete(s.groceryManual).where(eq(s.groceryManual.id, id));
  revalidatePath("/groceries");
  return { ok: true };
}

// ---------- Today card ----------

export async function setHabitDone(date: string, personId: number, habitSlug: string, done: boolean): Promise<Result> {
  const db = await getDb();
  const [habit] = await db.select({ id: s.habits.id }).from(s.habits).where(eq(s.habits.slug, habitSlug)).limit(1);
  if (!habit) return fail("Unknown habit");
  await db
    .insert(s.habitLog)
    .values({ date, personId, habitId: habit.id, done })
    .onConflictDoUpdate({ target: [s.habitLog.date, s.habitLog.personId, s.habitLog.habitId], set: { done } });
  return { ok: true };
}

export async function setPrepDone(date: string, taskKey: string, done: boolean): Promise<Result> {
  // A night-before task is stored under its due evening whichever screen ticked it, so Today and the prep guide share the row.
  const due = dueDateOfKey(taskKey);
  if (due) date = due;
  await (await getDb())
    .insert(s.prepTaskState)
    .values({ date, taskKey, done })
    .onConflictDoUpdate({ target: [s.prepTaskState.date, s.prepTaskState.taskKey], set: { done } });
  return { ok: true };
}

export async function enableShake(planId: number): Promise<Result> {
  const view = await getPlanView(planId);
  if (!view) return fail("Plan not found");
  if (view.mealTypes.includes("shake")) return { ok: true };
  await (await getDb())
    .update(s.planSetups)
    .set({ mealTypes: [...view.mealTypes, "shake"] })
    .where(eq(s.planSetups.id, view.setupId));
  return regeneratePlan(planId);
}

// ---------- Settings: reset ----------

/** Deletes user data for one scope after backing the database up. Content under /data is never touched. */
export async function resetScope(scope: string, typed: string): Promise<Result<{ backup: string | null }>> {
  if (!(RESET_SCOPES as readonly string[]).includes(scope)) return fail("Unknown reset option");
  const sc = scope as ResetScope;
  if (NEEDS_TYPED_CONFIRM.includes(sc) && typed.trim() !== CONFIRM_WORD) return fail(`Type ${CONFIRM_WORD} to confirm`);
  try {
    const backup = await backupBeforeReset(await getSqlite(), process.cwd(), sc);
    await resetData(await getDb(), sc);
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
  const parsed = ViewInput.safeParse({ list, query });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That view cannot be saved");
  await setDefaultView(await getDb(), parsed.data.list, parsed.data.query);
  revalidatePath(`/${parsed.data.list}`);
  return { ok: true };
}

export async function clearDefaultView(list: string): Promise<Result> {
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
  const written = await writePartMode(await getDb(), getData().recipes, planId, componentSlug, mode);
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
  const result = await addLinkChecked(await getDb(), getData().recipes, input);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true, id: result.id };
}

export async function updateLink(id: number, input: LinkInput): Promise<Result> {
  const result = await updateLinkChecked(await getDb(), getData().recipes, id, input);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true };
}

export async function removeLink(id: number): Promise<Result> {
  const result = await removeLinkChecked(await getDb(), id);
  if (!result.ok) return result;
  refreshRecipe(result.recipeSlug);
  return { ok: true };
}

export async function moveLink(id: number, direction: "up" | "down"): Promise<Result> {
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
  const catalog = catalogByHabit(getRoutineCatalog(getData()));
  const res = await savePersonRoutine(await getDb(), catalog, personId, habitSlug, patch);
  if (!res.ok) return fail(res.error);
  revalidatePath(`/profiles/${personId}`);
  revalidatePath("/profiles");
  return { ok: true };
}
