import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../lib/db/schema";
import { loadData } from "../lib/data/load";
import { getRoutineCatalog } from "../lib/routines/catalog";
import { requireMember } from "../lib/auth/access";
import { getData, getDb } from "../lib/server/context";
import { getPlanView } from "../lib/server/queries";
import { loadNight } from "../lib/server/prep";
import { todayISO } from "../lib/server/time";
import { persistNewPlan } from "../lib/server/plan-persistence";
import {
  addManualItem, deletePlan, enableShake, getSwapOptions, markPlanStep, regeneratePlan, removeManualItem,
  setGroceryChecked, setManualChecked, setPartMode, setPortion, setPrepDone, swapSlot, toggleLock, setPersonRoutine, setHabitDone,
} from "../app/actions";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn(), actionDenial: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

const data = loadData(process.cwd());
const routine = getRoutineCatalog(data)[0]!;
let h: DbHandle;
let own: number;
let foreign: number;
let ownSlot: number;
let foreignSlot: number;
let ingredientId: number;

beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values(["a", "b"].map((householdId, i) => ({
    id: i + 1, householdId, name: householdId, sex: "other" as const, birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  })));
  await h.db.insert(s.authUsers).values(["a", "b"].map((id) => ({
    id, name: id, email: `${id}@example.test`, emailVerified: true,
  })));
  await h.db.insert(s.householdMembers).values(["a", "b"].map((householdId, i) => ({
    householdId, userId: householdId, personId: i + 1, role: "owner" as const,
  })));
  const recipe = data.recipes.get("falafel-bowl")!;
  const [stored] = await h.db.insert(s.recipes).values({
    slug: recipe.slug, name: recipe.name, kind: recipe.kind, family: recipe.family, mealSlots: recipe.meal_slots,
    cuisine: recipe.cuisine, isIndian: recipe.is_indian, servings: recipe.servings, prepMin: recipe.prep_min,
    activeMin: recipe.active_min, totalMin: recipe.total_min, equipment: recipe.equipment, tags: recipe.tags, fridgeDays: recipe.fridge_days,
  }).returning({ id: s.recipes.id });
  const [ingredient] = await h.db.insert(s.ingredients).values({
    slug: "synthetic-item", name: "Synthetic", state: "ready", source: "USDA", sourceId: "synthetic-fixture",
    aisle: "test", isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    kcal: 100, proteinG: 5, carbsG: 10, fatG: 4, fibreG: 1, aliases: [], whereToBuy: [],
  }).returning({ id: s.ingredients.id });
  ingredientId = ingredient!.id;
  for (const [householdId, personId] of [["a", 1], ["b", 2]] as const) {
    const id = await persistNewPlan(h.db, {
      setup: {
        householdId, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true },
        prepStyle: "leftovers", createdAt: "2026-10-24T00:00:00Z",
      },
      seed: 42, slots: [{
        date: "2026-11-04", slot: "dinner", recipeSlug: recipe.slug, servings: { [personId]: 1 }, locked: false, reasons: [],
      }], routines: [], recipeIds: new Map([[recipe.slug, stored!.id]]),
    });
    const [slot] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, id));
    if (householdId === "a") { own = id; ownSlot = slot!.id; }
    else { foreign = id; foreignSlot = slot!.id; }
  }
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
});

it("refuses foreign profile routines/habits while preserving valid owner and member-self writes", async () => {
  const [habit] = await h.db.insert(s.habits).values({
    slug: routine.habitSlug, title: routine.title, category: "routine_drink",
    evidenceGrade: "practical", evidenceNote: "Synthetic fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  expect((await setPersonRoutine(2, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 2, routine.habitSlug, true)).ok).toBe(false);
  expect(await h.db.select().from(s.personRoutines)).toEqual([]);
  expect(await h.db.select().from(s.habitLog)).toEqual([]);
  expect(await setPersonRoutine(1, routine.habitSlug, { active: true })).toEqual({ ok: true });
  const [stored] = await h.db.select().from(s.personRoutines);
  expect(stored).toMatchObject({ personId: 1, habitId: habit!.id, active: true });
  expect(await h.db.select().from(s.syncState)).toHaveLength(1);
  expect(await setHabitDone("2026-11-02", 1, routine.habitSlug, true)).toEqual({ ok: true });
  expect(await setHabitDone("2026-11-02", 1, routine.habitSlug, false)).toEqual({ ok: true });
  expect(await h.db.select().from(s.habitLog)).toMatchObject([{ personId: 1, done: false }]);
  expect((await setPersonRoutine(1, routine.habitSlug, { active: true, days: [] })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 1, "missing", true)).ok).toBe(false);
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "member", personId: 1 });
  expect(await setPersonRoutine(1, routine.habitSlug, { active: false })).toEqual({ ok: true });
  const [other] = await h.db.insert(s.people).values({
    id: 3, householdId: "a", name: "Another synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  expect((await setPersonRoutine(other!.id, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", other!.id, routine.habitSlug, true)).ok).toBe(false);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  expect((await setPersonRoutine(1, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 1, routine.habitSlug, true)).ok).toBe(false);
});

it("propagates profile infrastructure failures and rolls routine choices and sync markers back together", async () => {
  await h.db.insert(s.habits).values({
    slug: routine.habitSlug, title: routine.title, category: "routine_drink",
    evidenceGrade: "practical", evidenceNote: "Synthetic fixture", defaultOn: false,
  });
  await h.db.execute(sql`alter table sync_state add constraint synthetic_sync_failure check (data_class <> 'person-routines')`);
  await expect(setPersonRoutine(1, routine.habitSlug, { active: true })).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.personRoutines)).toEqual([]);
  expect(await h.db.select().from(s.syncState)).toEqual([]);
});

it("refuses every foreign plan and shopping mutation even for a household owner", async () => {
  const [item] = await h.db.insert(s.groceryManual).values({ planId: foreign, text: "Foreign", checked: false }).returning({ id: s.groceryManual.id });
  const before = await h.db.select().from(s.planSlots);
  for (const action of [
    () => toggleLock(foreign, foreignSlot, true),
    () => setPortion(foreign, foreignSlot, 2, 2),
    () => deletePlan(foreign),
    () => regeneratePlan(foreign),
    () => enableShake(foreign),
    () => getSwapOptions(foreign, foreignSlot),
    () => swapSlot(foreign, foreignSlot, "falafel-bowl"),
    () => markPlanStep(foreign, "shopping"),
    () => setGroceryChecked(foreign, "synthetic-item", true),
    () => addManualItem(foreign, "Must never persist"),
    () => setManualChecked(item!.id, true),
    () => removeManualItem(item!.id),
    () => setPartMode(foreign, "baked-falafel", "have"),
    () => setPrepDone("2026-11-03", `night:${foreign}:2026-11-03:component:baked-falafel:0`, true),
  ]) expect((await action()).ok).toBe(false);
  expect(await h.db.select().from(s.planSlots)).toEqual(before);
  expect(await h.db.select().from(s.groceryManual)).toMatchObject([{ planId: foreign, checked: false }]);
  expect(await h.db.select().from(s.plans)).toHaveLength(2);
  for (const table of [s.groceryState, s.planProgress, s.planPartState, s.prepTaskState]) {
    expect(await h.db.select().from(table)).toEqual([]);
  }
});

it("persists valid owned slot, portion, milestone, shopping and part changes", async () => {
  expect(await toggleLock(own, ownSlot, true)).toEqual({ ok: true });
  expect(await setPortion(own, ownSlot, 1, 2.26)).toEqual({ ok: true });
  expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, ownSlot)))[0]!.locked).toBe(true);
  expect((await h.db.select().from(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, ownSlot)))[0]!.servings).toBe(2.25);
  expect(await markPlanStep(own, "shopping")).toEqual({ ok: true });
  expect(await setGroceryChecked(own, "synthetic-item", true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryState)).toMatchObject([{ planId: own, ingredientId, checked: true }]);
  const added = await addManualItem(own, " Synthetic shopping ");
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error("Synthetic item was not saved.");
  expect(await setManualChecked(added.id, true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryManual)).toMatchObject([{ text: "Synthetic shopping", checked: true }]);
  expect(await removeManualItem(added.id)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryManual)).toEqual([]);
  expect(await setPartMode(own, "baked-falafel", "have")).toEqual({ ok: true });
  expect(await h.db.select().from(s.planPartState)).toMatchObject([{ planId: own, componentSlug: "baked-falafel", mode: "have" }]);
});

it("refuses foreign child ids, invalid portions, missing items and stale membership", async () => {
  expect((await toggleLock(own, foreignSlot, true)).ok).toBe(false);
  expect((await setPortion(own, ownSlot, 2, 1)).ok).toBe(false);
  for (const servings of [NaN, Infinity, -1, 5]) expect((await setPortion(own, ownSlot, 1, servings)).ok).toBe(false);
  for (const id of [-1, 999]) {
    expect((await toggleLock(id, ownSlot, true)).ok).toBe(false);
    expect((await setManualChecked(id, true)).ok).toBe(false);
    expect((await removeManualItem(id)).ok).toBe(false);
  }
  for (const id of [NaN, Infinity, 0]) {
    expect((await regeneratePlan(id)).ok).toBe(false);
    expect((await enableShake(id)).ok).toBe(false);
  }
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  expect((await toggleLock(own, ownSlot, true)).ok).toBe(false);
  expect((await addManualItem(own, "No stale writes")).ok).toBe(false);
});

it("writes prep ownership and refuses an existing foreign completion instead of transferring it", async () => {
  const view = (await getPlanView(own, []))!;
  const task = (await loadNight(view, todayISO())).tasks[0]!;
  expect(task).toBeDefined();
  expect(await setPrepDone("1900-01-01", task.key, true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.prepTaskState)).toEqual([
    { householdId: "a", date: task.dueDate, taskKey: task.key, done: true },
  ]);
  await h.db.update(s.prepTaskState).set({ householdId: "b" });
  expect((await setPrepDone(task.dueDate, task.key, false)).ok).toBe(false);
  expect(await h.db.select().from(s.prepTaskState)).toMatchObject([{ householdId: "b", done: true }]);
});

it("propagates persistence failures and rolls shake setup changes back when regeneration fails", async () => {
  await h.failWrite("plan_slots", "UPDATE", "synthetic_lock_failure");
  await expect(toggleLock(own, ownSlot, true)).rejects.toThrow();
  expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, ownSlot)))[0]!.locked).toBe(false);
  await h.dropFailure("plan_slots", "synthetic_lock_failure");
  const before = await h.db.select().from(s.planSetups);
  await h.failWrite("plan_slots", "INSERT", "synthetic_regeneration_failure");
  await expect(enableShake(own)).rejects.toThrow();
  expect(await h.db.select().from(s.planSetups)).toEqual(before);
});
