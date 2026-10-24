import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../lib/db/schema";
import { loadData } from "../lib/data/load";
import { getRoutineCatalog } from "../lib/routines/catalog";
import { writePersonRoutine } from "../lib/human/routines";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { requireMember } from "../lib/auth/access";
import { getData, getDb } from "../lib/server/context";
import {
  getBatchPrepTicks, getPartModes, getPlanMilestones, getPlanRoutines, getPlanView, groceryChecks,
  lastSetup, latestPlanId, latestPlanMilestones, listPeople, listPlans,
  getPerson, getPrefs, getPersonRoutines, getTodayRoutines, getHabitsFor,
  getSavedViews, getDefaultViewQuery,
  feedbackMap, getCandidates,
  getRecipeLinks,
} from "../lib/server/queries";
import { loadNight, mealsOf, migrateTickKeys, tonight } from "../lib/server/prep";
import { persistNewPlan } from "../lib/server/plan-persistence";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

const data = loadData(process.cwd());
const recipe = [...data.recipes.values()].find((r) =>
  r.kind === "recipe" && r.meal_slots.includes("dinner") && r.advance_prep.some((a) => a.lead_hours >= 4))!;
let h: DbHandle;
let planId: number;

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
  const [row] = await h.db.insert(s.recipes).values({
    slug: recipe.slug, name: recipe.name, kind: recipe.kind, family: recipe.family, mealSlots: recipe.meal_slots,
    cuisine: recipe.cuisine, isIndian: recipe.is_indian, servings: recipe.servings, prepMin: recipe.prep_min,
    activeMin: recipe.active_min, totalMin: recipe.total_min, equipment: recipe.equipment, tags: recipe.tags, fridgeDays: recipe.fridge_days,
  }).returning({ id: s.recipes.id });
  for (const [householdId, personId] of [["a", 1], ["b", 2]] as const) {
    const id = await persistNewPlan(h.db, {
      setup: {
        householdId, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        healthFocus: { nutrientDense: false, lowSugar: true, light: true },
        cuisineBalance: 0.5, maxActiveMin: 20, prepStyle: "leftovers", createdAt: "2026-10-24T00:00:00Z",
      },
      seed: 42, slots: [{
        date: "2026-11-04", slot: "dinner", recipeSlug: recipe.slug, servings: { [personId]: 1 }, locked: false, reasons: [],
      }], routines: [], recipeIds: new Map([[recipe.slug, row!.id]]),
    });
    if (householdId === "a") planId = id;
  }
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
});

it("loads only the verified request household's people and last setup", async () => {
  expect((await listPeople()).map((p) => p.id)).toEqual([1]);
  expect(await lastSetup()).toMatchObject({ personIds: [1], days: 7 });
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect((await listPeople()).map((p) => p.id)).toEqual([2]);
  expect(await lastSetup()).toMatchObject({ personIds: [2] });
  await h.db.delete(s.plans).where(eq(s.plans.householdId, "b"));
  await h.db.delete(s.planSetups).where(eq(s.planSetups.householdId, "b"));
  expect(await lastSetup()).toBeUndefined();
});

it("reads only household saved views and never adopts an unowned legacy default", async () => {
  await h.db.insert(s.savedViews).values([
    { householdId: null, list: "recipes", name: "Legacy", query: "q=legacy", isDefault: true },
    { householdId: "a", list: "recipes", name: "First default", query: "q=first", isDefault: true },
    { householdId: "a", list: "recipes", name: "First named", query: "q=named", isDefault: false },
    { householdId: "b", list: "recipes", name: "Other private default", query: "q=other", isDefault: true },
  ]);
  expect((await getSavedViews("recipes")).map((v) => v.name)).toEqual(["First default", "First named"]);
  expect(await getDefaultViewQuery("recipes")).toBe("q=first");
  expect(await getSavedViews("ingredients")).toEqual([]);
  expect(await getDefaultViewQuery("ingredients")).toBeNull();
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect((await getSavedViews("recipes")).map((v) => v.name)).toEqual(["Other private default"]);
  expect(await getDefaultViewQuery("recipes")).toBe("q=other");
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "b"));
  await expect(getSavedViews("recipes")).rejects.toThrow("Select an available household");
  await expect(getDefaultViewQuery("recipes")).rejects.toThrow("Select an available household");
});

it("returns only the request household's recipe links", async () => {
  const [stored] = await h.db.select().from(s.recipes);
  for (const householdId of ["a", "b", null]) {
    await h.db.insert(s.recipeLinks).values({
      householdId, recipeId: stored!.id, uid: `fixture-${householdId}`, kind: "recipe",
      url: `https://example.com/${householdId}`, title: `Private ${householdId}`, position: 0,
      createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
    });
  }
  expect((await getRecipeLinks(recipe.slug)).map((r) => r.title)).toEqual(["Private a"]);
  expect(await getRecipeLinks("missing")).toEqual([]);
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect((await getRecipeLinks(recipe.slug)).map((r) => r.title)).toEqual(["Private b"]);
});

it("scopes historical/personal feedback and candidate filtering to the selected household profiles", async () => {
  const [stored] = await h.db.select().from(s.recipes).where(eq(s.recipes.slug, recipe.slug));
  await writePersonalRecipeFeedback(h.db, 1, stored!.id, { rating: 5, banned: false }, "a");
  await writePersonalRecipeFeedback(h.db, 2, stored!.id, { rating: 1, banned: true }, "b");
  expect((await feedbackMap()).get(recipe.slug)).toMatchObject({ banned: false, tested: true });
  expect((await feedbackMap(1)).get(recipe.slug)).toMatchObject({ rating: 5, banned: false });
  await expect(feedbackMap(2)).rejects.toThrow("profiles outside");
  await expect(getCandidates([1, 2])).rejects.toThrow("profiles outside");
  await expect(getCandidates([999])).rejects.toThrow("profiles outside");
  expect((await getCandidates([1])).find((c) => c.slug === recipe.slug)).toMatchObject({ banned: false, rating: 5 });
  expect((await getCandidates()).find((c) => c.slug === recipe.slug)).toMatchObject({ banned: false });
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect((await feedbackMap(2)).get(recipe.slug)).toMatchObject({ rating: 1, banned: true });
  expect((await getCandidates([2])).find((c) => c.slug === recipe.slug)).toMatchObject({ banned: true, rating: 1 });
});

it("scopes profile preferences, routines and daily habits without foreign empty-success projections", async () => {
  const routine = getRoutineCatalog(data)[0]!;
  const [habit] = await h.db.insert(s.habits).values({
    slug: routine.habitSlug, title: routine.title, category: "routine_drink", evidenceGrade: "practical",
    evidenceNote: "Synthetic fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  await writePersonRoutine(h.db, 1, habit!.id, { active: true, days: [1], timeOfDay: "morning", servings: 1.5 });
  await h.db.insert(s.habitLog).values({ date: "2026-11-02", personId: 1, habitId: habit!.id, done: true });
  const [ingredient] = await h.db.insert(s.ingredients).values({
    slug: "synthetic-preference", name: "Synthetic", state: "ready", source: "USDA", sourceId: "synthetic-fixture",
    aisle: "test", isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    kcal: 100, proteinG: 5, carbsG: 10, fatG: 4, fibreG: 1, aliases: [], whereToBuy: [],
  }).returning({ id: s.ingredients.id });
  await h.db.insert(s.preferences).values({ personId: 1, ingredientId: ingredient!.id, kind: "like" });
  expect((await getPerson(1))?.id).toBe(1);
  expect(await getPerson(2)).toBeUndefined();
  expect(await getPerson(999)).toBeUndefined();
  const readers = [
    getPrefs, getPersonRoutines, (id: number) => getTodayRoutines(id, "2026-11-02"),
    (id: number) => getHabitsFor("2026-11-02", id),
  ];
  for (const reader of readers) {
    await expect(reader(1)).resolves.toBeDefined();
    await expect(reader(2)).rejects.toThrow("profile is not available in your household");
    await expect(reader(999)).rejects.toThrow("profile is not available in your household");
  }
  expect(await getPrefs(1)).toEqual({ liked: ["synthetic-preference"], avoided: [] });
  expect(await getPersonRoutines(1)).toEqual([{
    habitSlug: routine.habitSlug, active: true, days: [1], timeOfDay: "morning", servings: 1.5,
  }]);
  expect(await getTodayRoutines(1, "2026-11-02")).toEqual([{
    habitSlug: routine.habitSlug, timeOfDay: "morning", servings: 1.5, done: true,
  }]);
  expect((await getHabitsFor("2026-11-02", 1)).doneIds).toEqual(new Set([habit!.id]));
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect((await getPerson(2))?.id).toBe(2);
  expect(await getPrefs(2)).toEqual({ liked: [], avoided: [] });
  expect(await getPersonRoutines(2)).toEqual([]);
  expect(await getTodayRoutines(2, "2026-11-02")).toEqual([]);
  expect((await getHabitsFor("2026-11-02", 2)).doneIds).toEqual(new Set());
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "a"));
  for (const reader of [getPerson, ...readers]) {
    await expect(reader(1)).rejects.toThrow("verified account");
  }
});

it("selects only request-owned latest/list/detail plans, including when a foreign plan is newer", async () => {
  const [foreign] = await h.db.select().from(s.plans).where(eq(s.plans.householdId, "b"));
  expect(foreign!.id).toBeGreaterThan(planId);
  expect(await latestPlanId()).toBe(planId);
  expect((await listPlans()).map((row) => row.id)).toEqual([planId]);
  expect((await getPlanView(planId, []))?.people.map((person) => person.id)).toEqual([1]);
  expect(await getPlanView(foreign!.id, [])).toBeUndefined();
  expect(await getPlanView(999, [])).toBeUndefined();
  expect(await latestPlanMilestones()).toMatchObject({ planId, milestones: { reviewed: false, shopping: false, prep: false } });
  await h.db.delete(s.plans).where(eq(s.plans.id, planId));
  expect(await latestPlanId()).toBeUndefined();
  expect(await latestPlanMilestones()).toBeNull();
});

it("checks the owned parent before reading grocery, part, routine, milestone and prep children", async () => {
  const [foreign] = await h.db.select().from(s.plans).where(eq(s.plans.householdId, "b"));
  await h.db.insert(s.groceryManual).values({ planId: foreign!.id, text: "Foreign private shopping", checked: true });
  const readers = [groceryChecks, getPartModes, getPlanRoutines, getPlanMilestones, getBatchPrepTicks];
  for (const reader of readers) {
    await expect(reader(foreign!.id)).rejects.toThrow("not available in your household");
    await expect(reader(999)).rejects.toThrow("not available in your household");
    await expect(reader(planId)).resolves.toBeDefined();
  }
  await h.db.insert(s.prepTaskState).values([
    { householdId: "a", date: "2026-11-03", taskKey: `prep:${planId}:own`, done: true },
    { householdId: "b", date: "2026-11-03", taskKey: `prep:${planId}:foreign`, done: true },
  ]);
  expect(await getBatchPrepTicks(planId)).toEqual([{ taskKey: `prep:${planId}:own`, done: true }]);
});

it("refuses malformed selected profiles and portions instead of projecting partial household plans", async () => {
  const [plan] = await h.db.select().from(s.plans).where(eq(s.plans.id, planId));
  for (const personIds of [[], [1, 1], [1, 2], [999]]) {
    await h.db.update(s.planSetups).set({ personIds }).where(eq(s.planSetups.id, plan!.setupId));
    await expect(getPlanView(planId, [])).rejects.toThrow("profiles outside");
    await expect(getPartModes(planId)).rejects.toThrow("profiles outside");
  }
  await h.db.update(s.planSetups).set({ personIds: [1] }).where(eq(s.planSetups.id, plan!.setupId));
  const [slot] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, planId));
  await h.db.insert(s.planSlotPortions).values({ planSlotId: slot!.id, personId: 2, servings: 1 });
  await expect(getPlanView(planId, [])).rejects.toThrow("portions outside");
});

it("refuses a routine snapshot for a profile outside the plan's selected household profiles", async () => {
  const [habit] = await h.db.insert(s.habits).values({
    slug: "synthetic-routine", title: "Synthetic", category: "routine_drink", evidenceGrade: "practical",
    evidenceNote: "Synthetic", defaultOn: false,
  }).returning({ id: s.habits.id });
  await h.db.insert(s.planRoutines).values({
    planId, personId: 2, habitId: habit!.id, days: [1], timeOfDay: "morning", servings: 1,
  });
  await expect(getPlanRoutines(planId)).rejects.toThrow("routines outside");
  await h.db.delete(s.planRoutines).where(eq(s.planRoutines.personId, 2));
  await h.db.insert(s.planRoutines).values({
    planId, personId: 1, habitId: habit!.id, days: [1], timeOfDay: "morning", servings: 1,
  });
  expect(await getPlanRoutines(planId)).toMatchObject([{ personId: 1, habitSlug: "synthetic-routine" }]);
});

it("rechecks ownership and verification instead of trusting a previously admitted request", async () => {
  await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "a"));
  await expect(listPeople()).rejects.toThrow();
  await expect(lastSetup()).rejects.toThrow();
  await h.db.update(s.householdMembers).set({ householdId: "a" }).where(eq(s.householdMembers.userId, "a"));
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "a"));
  await expect(listPeople()).rejects.toThrow();
  await expect(lastSetup()).rejects.toThrow();
});

it("migrates only the plan household's legacy prep ticks and preserves ownership on reload", async () => {
  const view = (await getPlanView(planId, []))!;
  const first = await loadNight(view, "2026-11-02");
  expect(first.tasks.length).toBeGreaterThan(0);
  const task = first.tasks[0]!;
  const old = `night:${planId}:${task.dueDate}:0:${task.text}`;
  await h.db.insert(s.prepTaskState).values([
    { householdId: "a", date: task.dueDate, taskKey: old, done: true },
    { householdId: "b", date: task.dueDate, taskKey: "2026-11-04:foreign:0", done: true },
  ]);
  expect((await loadNight(view, "2026-11-02")).tasks[0]!.done).toBe(true);
  const ticks = await h.db.select().from(s.prepTaskState);
  expect(ticks).toContainEqual({ householdId: "a", date: task.dueDate, taskKey: task.key, done: true });
  expect(ticks).toContainEqual({ householdId: "b", date: task.dueDate, taskKey: "2026-11-04:foreign:0", done: true });
  await loadNight(view, "2026-11-02");
  expect(await h.db.select().from(s.prepTaskState)).toEqual(ticks);
});

it("rolls back a legacy tick rename rather than merging into a foreign-owned completion", async () => {
  const view = (await getPlanView(planId, []))!;
  const task = (await loadNight(view, "2026-11-02")).tasks[0]!;
  const old = `night:${planId}:${task.dueDate}:0:${task.text}`;
  await h.db.insert(s.prepTaskState).values([
    { householdId: "a", date: task.dueDate, taskKey: old, done: true },
    { householdId: "b", date: task.dueDate, taskKey: task.key, done: true },
  ]);
  const before = await h.db.select().from(s.prepTaskState);
  await expect(migrateTickKeys(planId, [task])).rejects.toThrow("ownership conflicts");
  expect(await h.db.select().from(s.prepTaskState)).toEqual(before);
  await h.db.delete(s.prepTaskState).where(eq(s.prepTaskState.taskKey, old));
  expect((await loadNight(view, "2026-11-02")).tasks[0]!.done).toBe(false);
});

it("refuses prep migration for missing or unowned plans", async () => {
  await expect(migrateTickKeys(999, [])).rejects.toThrow("household-owned");
  await h.db.update(s.plans).set({ householdId: null }).where(eq(s.plans.id, planId));
  await expect(migrateTickKeys(planId, [])).rejects.toThrow("household-owned");
});

it("preserves legacy missing leftover flags when projecting prep meals", async () => {
  const view = (await getPlanView(planId, []))!;
  expect(mealsOf({ ...view, slots: view.slots.map((slot) => ({ ...slot, isLeftover: undefined })) })[0])
    .toMatchObject({ leftover: false, servings: 1 });
});

it("drops unmatched or incomplete owned legacy ticks and merges only owned completed ticks", async () => {
  const view = (await getPlanView(planId, []))!;
  const night = await loadNight(view, "2026-11-02");
  const task = night.tasks[0]!;
  expect(tonight(undefined, task.dueDate)).toEqual([]);
  expect(tonight(night, task.dueDate)).toContainEqual(task);
  expect(tonight(night, "2000-01-01")).toEqual([]);
  const old = `night:${planId}:${task.dueDate}:0:${task.text}`;
  await h.db.insert(s.prepTaskState).values([
    { householdId: "a", date: task.dueDate, taskKey: old, done: false },
    { householdId: "a", date: task.dueDate, taskKey: "2026-11-04:missing:0", done: true },
  ]);
  await migrateTickKeys(planId, [task]);
  expect(await h.db.select().from(s.prepTaskState)).toEqual([]);
  await h.db.insert(s.prepTaskState).values([
    { householdId: "a", date: task.dueDate, taskKey: old, done: true },
    { householdId: "a", date: task.dueDate, taskKey: task.key, done: false },
  ]);
  await migrateTickKeys(planId, [task]);
  expect(await h.db.select().from(s.prepTaskState)).toEqual([
    { householdId: "a", date: task.dueDate, taskKey: task.key, done: true },
  ]);
});
