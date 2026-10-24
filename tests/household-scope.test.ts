import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import * as s from "../lib/db/schema";
import type { PlannedSlot } from "../lib/planner/types";
import { refreshHouseholdAccess, requireHouseholdProfile, resolveHouseholdAccess, resolveOnlyHouseholdAccess, type HouseholdAccess } from "../lib/auth/household-access";
import {
  deleteHouseholdPlan, householdPeople, householdPerson, householdPlan, householdPlans,
  deleteHouseholdPerson, persistHouseholdPlan, regenerateHouseholdPlan, saveHouseholdPerson, saveHouseholdPreferences,
  mutateHouseholdPlan, mutateHouseholdPerson, mutateHouseholdState,
} from "../lib/server/household-plans";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { householdAccount } from "../lib/server/household-account";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let a: HouseholdAccess;
let b: HouseholdAccess;
let otherPerson: number;
let recipeId: number;
let habitId: number;

beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First household" }, { id: "b", name: "Second household" }]);
  const people = await h.db.insert(s.people).values(["a", "b"].map((householdId) => ({
    householdId, name: "Synthetic profile", sex: "other" as const, birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  }))).returning({ id: s.people.id });
  otherPerson = people[1]!.id;
  await h.db.insert(s.authUsers).values(["a", "b", "pending", "unverified"].map((id) => ({
    id, name: "Synthetic account", email: `${id}@example.test`, emailVerified: id !== "unverified",
  })));
  await h.db.insert(s.householdMembers).values([
    { householdId: "a", userId: "a", personId: people[0]!.id, role: "owner" },
    { householdId: "b", userId: "b", personId: otherPerson, role: "owner" },
    { householdId: "a", userId: "pending", personId: null, role: "member" },
    { householdId: "a", userId: "unverified", personId: null, role: "member" },
  ]);
  [a, b] = await Promise.all([resolveHouseholdAccess(h.db, "a", "a"), resolveHouseholdAccess(h.db, "b", "b")]);
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "scope-fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  }).returning({ id: s.recipes.id });
  recipeId = recipe!.id;
  const [habit] = await h.db.insert(s.habits).values({
    slug: "scope-fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  habitId = habit!.id;
});

function input(personId = a.personId!) {
  const slots: PlannedSlot[] = [{
    recipeSlug: "scope-fixture", date: "2026-11-02", slot: "dinner", servings: { [personId]: 1 }, locked: false, reasons: [],
  }];
  return {
    setup: {
      personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
      cuisineBalance: 0.5, maxActiveMin: null, healthFocus: { nutrientDense: true, lowSugar: true, light: true },
      prepStyle: "leftovers" as const, createdAt: "2026-11-01T12:00:00.000Z",
    },
    seed: 42, slots, routines: [{ planId: 0, personId, habitId, days: [1], timeOfDay: "morning", servings: 1 }],
    recipeIds: new Map([["scope-fixture", recipeId]]),
  };
}

it("refreshes and locks profile ownership, enforces member self edits and rolls callback failures back", async () => {
  let called = 0;
  const write = async () => { called++; return "saved"; };
  await expect(mutateHouseholdPerson(h.db, a, otherPerson, write)).rejects.toThrow("not in this household");
  await expect(mutateHouseholdPerson(h.db, a, 999, write)).rejects.toThrow("not in this household");
  expect(called).toBe(0);
  const [additional] = await h.db.insert(s.people).values({
    householdId: "a", name: "Another synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  expect(await mutateHouseholdPerson(h.db, a, additional!.id, write)).toBe("saved");
  await expect(mutateHouseholdPerson(h.db, a, a.personId!, async (tx) => {
    await tx.update(s.people).set({ name: "Must roll back" }).where(eq(s.people.id, a.personId!));
    throw new Error("Synthetic profile write failure");
  })).rejects.toThrow("Synthetic profile write failure");
  expect((await h.db.select().from(s.people).where(eq(s.people.id, a.personId!)))[0]!.name).toBe("Synthetic profile");
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  await expect(mutateHouseholdPerson(h.db, a, a.personId!, write)).rejects.toThrow("access changed");
  const member = await resolveHouseholdAccess(h.db, "a", "a");
  expect(await mutateHouseholdPerson(h.db, member, member.personId!, write)).toBe("saved");
  await expect(mutateHouseholdPerson(h.db, member, additional!.id, write)).rejects.toThrow("own profile");
  const pending = await resolveHouseholdAccess(h.db, "pending", "a");
  await expect(mutateHouseholdPerson(h.db, pending, member.personId!, write)).rejects.toThrow("Finish");
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  await expect(mutateHouseholdPerson(h.db, member, member.personId!, write)).rejects.toThrow("not available");
  expect(called).toBe(2);
});

it("refreshes shared household state access before callbacks and keeps failures atomic", async () => {
  expect(await mutateHouseholdState(h.db, a, async () => "saved")).toBe("saved");
  await expect(mutateHouseholdState(h.db, a, async (tx) => {
    await tx.insert(s.savedViews).values({ householdId: "a", list: "recipes", name: "Must roll back", query: "" });
    throw new Error("Synthetic shared-state failure");
  })).rejects.toThrow("Synthetic shared-state failure");
  expect(await h.db.select().from(s.savedViews)).toEqual([]);
  const pending = await resolveHouseholdAccess(h.db, "pending", "a");
  await expect(mutateHouseholdState(h.db, pending, async () => "never")).rejects.toThrow("Finish");
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  await expect(mutateHouseholdState(h.db, a, async () => "never")).rejects.toThrow("not available");
});

it("refreshes and locks plan ownership before any shared-state callback and rolls failures back", async () => {
  const id = await persistHouseholdPlan(h.db, a, input());
  const foreign = await persistHouseholdPlan(h.db, b, input(b.personId!));
  let called = 0;
  const write = async () => { called++; return "saved"; };
  await expect(mutateHouseholdPlan(h.db, a, foreign, write)).rejects.toThrow("not available in your household");
  await expect(mutateHouseholdPlan(h.db, a, 999, write)).rejects.toThrow("not available in your household");
  expect(called).toBe(0);
  expect(await mutateHouseholdPlan(h.db, a, id, write)).toBe("saved");
  expect(called).toBe(1);
  await expect(mutateHouseholdPlan(h.db, a, id, async (tx) => {
    await tx.insert(s.groceryManual).values({ planId: id, text: "Must roll back", checked: false });
    throw new Error("Synthetic mutation failure");
  })).rejects.toThrow("Synthetic mutation failure");
  expect(await h.db.select().from(s.groceryManual)).toEqual([]);
  const [slot] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, id));
  await h.db.update(s.planSlotPortions).set({ personId: otherPerson }).where(eq(s.planSlotPortions.planSlotId, slot!.id));
  await expect(mutateHouseholdPlan(h.db, a, id, write)).rejects.toThrow("selected household profiles");
  expect(called).toBe(1);
  await h.db.update(s.planSlotPortions).set({ personId: a.personId! }).where(eq(s.planSlotPortions.planSlotId, slot!.id));
  await h.db.update(s.planRoutines).set({ personId: otherPerson }).where(eq(s.planRoutines.planId, id));
  await expect(mutateHouseholdPlan(h.db, a, id, write)).rejects.toThrow("selected household profiles");
  expect(called).toBe(1);
  await h.db.update(s.planRoutines).set({ personId: a.personId! }).where(eq(s.planRoutines.planId, id));
  const [plan] = await h.db.select().from(s.plans).where(eq(s.plans.id, id));
  await h.db.update(s.planSetups).set({ personIds: [otherPerson] }).where(eq(s.planSetups.id, plan!.setupId));
  await expect(mutateHouseholdPlan(h.db, a, id, write)).rejects.toThrow("not in this household");
  expect(called).toBe(1);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  await expect(mutateHouseholdPlan(h.db, a, id, write)).rejects.toThrow("not available");
  expect(called).toBe(1);
});

it("resolves a verified membership, freezes selection and rejects another household even for an owner", async () => {
  expect(a).toMatchObject({ householdId: "a", userId: "a", role: "owner", personId: a.personId });
  expect(Object.isFrozen(a)).toBe(true);
  expect(Reflect.set(a, "householdId", "b")).toBe(false);
  for (const [user, household] of [["a", "b"], ["missing", "a"], ["unverified", "a"], ["a", "missing"]]) {
    await expect(resolveHouseholdAccess(h.db, user!, household!)).rejects.toThrow("not available");
  }
  await expect(refreshHouseholdAccess(h.db, { ...a, householdId: "b" })).rejects.toThrow("not available");
  const serialized = { ...a };
  for (const symbol of Object.getOwnPropertySymbols(serialized)) Reflect.deleteProperty(serialized, symbol);
  await expect(refreshHouseholdAccess(h.db, serialized)).rejects.toThrow("Resolve household membership");
});

it("allows incomplete membership only for onboarding and refuses private profiles/plans", async () => {
  const pending = await resolveHouseholdAccess(h.db, "pending", "a");
  expect(pending).toMatchObject({ role: "member", personId: null });
  expect(() => requireHouseholdProfile(pending)).toThrow("Finish your household profile");
  expect(requireHouseholdProfile(a)).toBe(a.personId);
  await expect(householdPeople(h.db, pending)).rejects.toThrow("Finish your household profile");
  await expect(persistHouseholdPlan(h.db, pending, input())).rejects.toThrow("Finish your household profile");
  expect(await h.db.select().from(s.plans)).toEqual([]);
});

it("rejects legacy unowned memberships and cross-household or unowned linked profiles", async () => {
  await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "a"));
  await expect(resolveHouseholdAccess(h.db, "a", "a")).rejects.toThrow("not available");
  await h.client.exec("ALTER TABLE household_members DISABLE TRIGGER ALL");
  await h.db.update(s.householdMembers).set({ householdId: "b" }).where(eq(s.householdMembers.userId, "a"));
  await h.client.exec("ALTER TABLE household_members ENABLE TRIGGER ALL");
  await expect(resolveHouseholdAccess(h.db, "a", "b")).rejects.toThrow("not available");
  await h.db.update(s.householdMembers).set({ householdId: "a" }).where(eq(s.householdMembers.userId, "a"));
  await h.client.exec("ALTER TABLE people DISABLE TRIGGER ALL");
  await h.db.update(s.people).set({ householdId: null }).where(eq(s.people.id, a.personId!));
  await h.client.exec("ALTER TABLE people ENABLE TRIGGER ALL");
  await expect(resolveHouseholdAccess(h.db, "a", "a")).rejects.toThrow("not available");
});

it("rechecks verification, membership, role and profile changes rather than trusting a stale scope", async () => {
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  await expect(refreshHouseholdAccess(h.db, a)).rejects.toThrow("access changed");
  const member = await resolveHouseholdAccess(h.db, "a", "a");
  expect(member.role).toBe("member");
  await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "a"));
  await expect(refreshHouseholdAccess(h.db, member)).rejects.toThrow("access changed");
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "a"));
  await expect(refreshHouseholdAccess(h.db, member)).rejects.toThrow("not available");
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  await expect(persistHouseholdPlan(h.db, a, input())).rejects.toThrow("not available");
  expect(await h.db.select().from(s.planSetups)).toEqual([]);
});

it("returns only profiles in the selected household and makes foreign or missing profile ids indistinguishable", async () => {
  expect(await householdPeople(h.db, a)).toMatchObject([{ id: a.personId, householdId: "a" }]);
  expect(await householdPeople(h.db, b)).toMatchObject([{ id: otherPerson, householdId: "b" }]);
  expect(await householdPerson(h.db, a, a.personId!)).toMatchObject({ id: a.personId });
  expect(await householdPerson(h.db, a, otherPerson)).toBeUndefined();
  expect(await householdPerson(h.db, a, 99999)).toBeUndefined();
});

it("atomically saves ownership with setup, portions and routines and isolates list/id lookups", async () => {
  const first = await persistHouseholdPlan(h.db, a, { ...input(), setup: { ...input().setup, householdId: "b" } });
  const second = await persistHouseholdPlan(h.db, b, input(otherPerson));
  expect(await householdPlans(h.db, a)).toMatchObject([{ id: first }]);
  expect(await householdPlans(h.db, b, 1)).toMatchObject([{ id: second }]);
  expect(await householdPlan(h.db, a, first)).toMatchObject({
    plan: { id: first, householdId: "a" }, setup: { householdId: "a", personIds: [a.personId] },
  });
  expect(await householdPlan(h.db, a, second)).toBeUndefined();
  expect(await householdPlan(h.db, a, 99999)).toBeUndefined();
  expect(await h.db.select().from(s.planSlotPortions)).toMatchObject([{ personId: a.personId }, { personId: otherPerson }]);
  expect(await h.db.select().from(s.planRoutines)).toMatchObject([{ planId: first, personId: a.personId }, { planId: second, personId: otherPerson }]);
  for (const invalid of [0, -1, 1.5, 501, NaN, Infinity]) await expect(householdPlans(h.db, a, invalid)).rejects.toThrow("Plan limit");
});

it("defensively excludes a plan whose setup was corrupted outside normal constraint enforcement", async () => {
  const id = await persistHouseholdPlan(h.db, a, input());
  await h.client.exec("ALTER TABLE plan_setups DISABLE TRIGGER ALL");
  await h.db.update(s.planSetups).set({ householdId: "b" });
  await h.client.exec("ALTER TABLE plan_setups ENABLE TRIGGER ALL");
  expect(await householdPlans(h.db, a)).toEqual([]);
  expect(await householdPlan(h.db, a, id)).toBeUndefined();
  expect(await householdPlans(h.db, b)).toEqual([]);
});

it("rejects empty, duplicate, invalid, missing and foreign profile selections before any plan write", async () => {
  for (const ids of [[], [a.personId!, a.personId!], [0], [-1], [1.5], [NaN], [999999], [otherPerson], [a.personId!, otherPerson]]) {
    const value = input();
    value.setup.personIds = ids;
    await expect(persistHouseholdPlan(h.db, a, value)).rejects.toThrow();
  }
  expect(await h.db.select().from(s.planSetups)).toEqual([]);
  expect(await h.db.select().from(s.plans)).toEqual([]);
});

it("rejects foreign, unselected or noncanonical portion ids and foreign routine snapshots before writing", async () => {
  for (const id of [String(otherPerson), "999999", `0${a.personId}`, "1e0", "NaN"]) {
    const value = input();
    value.slots[0]!.servings = { [id]: 1 };
    await expect(persistHouseholdPlan(h.db, a, value)).rejects.toThrow("Plan portions and routines");
  }
  const value = input();
  value.routines[0]!.personId = otherPerson;
  await expect(persistHouseholdPlan(h.db, a, value)).rejects.toThrow("Plan portions and routines");
  expect(await h.db.select().from(s.planSetups)).toEqual([]);
  expect(await h.db.select().from(s.planSlots)).toEqual([]);
});

it("permits multiple same-household profiles but rejects an existing unselected household profile", async () => {
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "b"));
  await h.db.update(s.people).set({ householdId: "a" }).where(eq(s.people.id, otherPerson));
  const value = input();
  value.slots[0]!.servings[otherPerson] = 0.5;
  await expect(persistHouseholdPlan(h.db, a, value)).rejects.toThrow("Plan portions and routines");
  value.setup.personIds.push(otherPerson);
  value.routines = [];
  const id = await persistHouseholdPlan(h.db, a, value);
  expect(await householdPlan(h.db, a, id)).toMatchObject({ setup: { personIds: [a.personId, otherPerson] } });
  expect(await h.db.select().from(s.planSlotPortions)).toHaveLength(2);
});

it("rolls back all owned rows when a downstream slot write fails and remains usable for retry", async () => {
  await h.failWrite("plan_slots", "insert", "scope_failure");
  await expect(persistHouseholdPlan(h.db, a, input())).rejects.toThrow();
  for (const table of [s.planSetups, s.plans, s.planSlots, s.planSlotPortions, s.planRoutines]) {
    expect(await h.db.select().from(table)).toEqual([]);
  }
  await h.dropFailure("plan_slots", "scope_failure");
  expect(await persistHouseholdPlan(h.db, a, input())).toBeGreaterThan(0);
});

it("rejects foreign/missing plan mutations and regenerates only the selected household plan", async () => {
  const id = await persistHouseholdPlan(h.db, a, input());
  const other = await persistHouseholdPlan(h.db, b, input(otherPerson));
  const value = input();
  const before = await h.db.select().from(s.plans);
  for (const unavailable of [other, 999999]) {
    await expect(regenerateHouseholdPlan(h.db, a, unavailable, 7, value.slots, value.recipeIds)).rejects.toThrow("not available");
    await expect(deleteHouseholdPlan(h.db, a, unavailable)).rejects.toThrow("not available");
  }
  expect(await h.db.select().from(s.plans)).toEqual(before);
  await regenerateHouseholdPlan(h.db, a, id, 7, [{ ...value.slots[0]!, servings: { [a.personId!]: 2 } }], value.recipeIds);
  expect(await householdPlan(h.db, a, id)).toMatchObject({ plan: { seed: 7, householdId: "a" } });
  expect(await householdPlan(h.db, b, other)).toMatchObject({ plan: { seed: 42, householdId: "b" } });
  await deleteHouseholdPlan(h.db, a, id);
  expect(await householdPlan(h.db, a, id)).toBeUndefined();
  expect(await householdPlans(h.db, b)).toHaveLength(1);
  expect(await h.db.select().from(s.planSetups)).toHaveLength(1);
});

it("refuses regeneration with foreign portions, routines or setup profiles and preserves the original plan", async () => {
  const id = await persistHouseholdPlan(h.db, a, input());
  const value = input();
  const before = await h.db.select().from(s.planSlots);
  await expect(regenerateHouseholdPlan(h.db, a, id, 7, [{ ...value.slots[0]!, servings: { [otherPerson]: 1 } }], value.recipeIds))
    .rejects.toThrow("Plan portions and routines");
  await h.db.update(s.planRoutines).set({ personId: otherPerson });
  await expect(regenerateHouseholdPlan(h.db, a, id, 7, value.slots, value.recipeIds)).rejects.toThrow("Plan portions and routines");
  await h.db.update(s.planRoutines).set({ personId: a.personId! });
  await h.db.update(s.planSlotPortions).set({ personId: otherPerson });
  await expect(regenerateHouseholdPlan(h.db, a, id, 7, value.slots, value.recipeIds)).rejects.toThrow("Plan portions and routines");
  await h.db.update(s.planSlotPortions).set({ personId: a.personId! });
  await h.db.update(s.planSetups).set({ personIds: [otherPerson] });
  await expect(regenerateHouseholdPlan(h.db, a, id, 7, value.slots, value.recipeIds)).rejects.toThrow("not in this household");
  expect(await h.db.select().from(s.planSlots)).toEqual(before);
  expect(await h.db.select().from(s.plans)).toMatchObject([{ seed: 42 }]);
});

it("rolls back regeneration/deletion failures without changing the other household", async () => {
  const id = await persistHouseholdPlan(h.db, a, input());
  await persistHouseholdPlan(h.db, b, input(otherPerson));
  const before = {
    plans: await h.db.select().from(s.plans), setups: await h.db.select().from(s.planSetups),
    slots: await h.db.select().from(s.planSlots), portions: await h.db.select().from(s.planSlotPortions),
  };
  const value = input();
  await h.failWrite("plan_slots", "insert", "regenerate_scope_failure");
  await expect(regenerateHouseholdPlan(h.db, a, id, 7, value.slots, value.recipeIds)).rejects.toThrow();
  await h.dropFailure("plan_slots", "regenerate_scope_failure");
  await h.failWrite("plan_setups", "delete", "delete_scope_failure");
  await expect(deleteHouseholdPlan(h.db, a, id)).rejects.toThrow();
  expect(await h.db.select().from(s.plans)).toEqual(before.plans);
  expect(await h.db.select().from(s.planSetups)).toEqual(before.setups);
  expect(await h.db.select().from(s.planSlots)).toEqual(before.slots);
  expect(await h.db.select().from(s.planSlotPortions)).toEqual(before.portions);
});

it("scopes ingredient preferences even for owners, retaining other household values", async () => {
  const [ingredient] = await h.db.insert(s.ingredients).values({
    slug: "scope-food", name: "Fixture", state: "ready", aliases: [], kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0,
    source: "CNF", sourceId: "fixture", aisle: "test", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  }).returning({ id: s.ingredients.id });
  await saveHouseholdPreferences(h.db, b, otherPerson, [{ ingredientId: ingredient!.id, kind: "like" }]);
  await expect(saveHouseholdPreferences(h.db, a, otherPerson, [])).rejects.toThrow("not in this household");
  await expect(saveHouseholdPreferences(h.db, a, 999999, [])).rejects.toThrow("not in this household");
  await saveHouseholdPreferences(h.db, a, a.personId!, [{ ingredientId: ingredient!.id, kind: "avoid" }]);
  expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, otherPerson))).toMatchObject([{ kind: "like" }]);
  expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, a.personId!))).toMatchObject([{ kind: "avoid" }]);
  await expect(saveHouseholdPreferences(h.db, a, a.personId!, [{ ingredientId: 999999, kind: "like" }])).rejects.toThrow();
  expect(await h.db.select().from(s.preferences).where(eq(s.preferences.personId, a.personId!))).toMatchObject([{ kind: "avoid" }]);
});

it("allows members to edit only their own preferences, and owners only other profiles in their household", async () => {
  const [second] = await h.db.insert(s.people).values({
    householdId: "a", name: "Second synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  await saveHouseholdPreferences(h.db, a, second!.id, []);
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  const member = await resolveHouseholdAccess(h.db, "a", "a");
  await saveHouseholdPreferences(h.db, member, a.personId!, []);
  await expect(saveHouseholdPreferences(h.db, member, second!.id, [])).rejects.toThrow("only change your own");
  expect(await persistHouseholdPlan(h.db, member, input())).toBeGreaterThan(0);
});

const profileInput = {
  name: "Synthetic added profile", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
  activityLevel: "light" as const, proteinMode: "per_kg" as const, proteinValue: 1.2, kcalTarget: null, reminderTime: null,
};

it("resolves only an explicit existing membership for transitional callers, never an unowned or missing account", async () => {
  expect(await resolveOnlyHouseholdAccess(h.db, "a")).toMatchObject({ householdId: "a", personId: a.personId });
  await expect(resolveOnlyHouseholdAccess(h.db, "missing")).rejects.toThrow("Select an available household");
  await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "a"));
  await expect(resolveOnlyHouseholdAccess(h.db, "a")).rejects.toThrow("Select an available household");
});

it("stores ownership on new profiles and rejects foreign edits even for owners", async () => {
  const created = await saveHouseholdPerson(h.db, a, profileInput);
  expect(await householdPerson(h.db, a, created.id)).toMatchObject({ householdId: "a", name: profileInput.name });
  await saveHouseholdPerson(h.db, a, { ...profileInput, id: created.id, name: "Updated synthetic profile" });
  expect(await householdPerson(h.db, a, created.id)).toMatchObject({ name: "Updated synthetic profile", householdId: "a" });
  await expect(saveHouseholdPerson(h.db, a, { ...profileInput, id: otherPerson })).rejects.toThrow("not in this household");
  await expect(saveHouseholdPerson(h.db, a, { ...profileInput, id: 999999 })).rejects.toThrow("not in this household");
  expect(await householdPerson(h.db, b, otherPerson)).toMatchObject({ name: "Synthetic profile" });
  await expect(saveHouseholdPerson(h.db, a, { ...profileInput, name: "" })).rejects.toThrow("Enter a name");
});

it("permits a member's own profile edit but not creation or another profile edit/deletion", async () => {
  const created = await saveHouseholdPerson(h.db, a, profileInput);
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  const member = await resolveHouseholdAccess(h.db, "a", "a");
  await saveHouseholdPerson(h.db, member, { ...profileInput, id: a.personId!, name: "Updated own profile" });
  await expect(saveHouseholdPerson(h.db, member, profileInput)).rejects.toThrow("only change your own");
  await expect(saveHouseholdPerson(h.db, member, { ...profileInput, id: created.id })).rejects.toThrow("only change your own");
  await expect(deleteHouseholdPerson(h.db, member, created.id)).rejects.toThrow("Only a household owner");
});

it("refuses foreign, missing, account-linked and saved-plan profiles before deletion", async () => {
  await expect(deleteHouseholdPerson(h.db, a, otherPerson)).rejects.toThrow("not in this household");
  await expect(deleteHouseholdPerson(h.db, a, 999999)).rejects.toThrow("not in this household");
  await expect(deleteHouseholdPerson(h.db, a, a.personId!)).rejects.toThrow("linked to an account");
  const created = await saveHouseholdPerson(h.db, a, profileInput);
  await persistHouseholdPlan(h.db, a, input(created.id));
  await expect(deleteHouseholdPerson(h.db, a, created.id)).rejects.toThrow("part of a saved plan");
  expect(await householdPerson(h.db, a, created.id)).toBeDefined();
});

it("rolls back failed profile writes and personal-feedback cleanup, then deletes only the owned profile", async () => {
  const created = await saveHouseholdPerson(h.db, a, profileInput);
  await writePersonalRecipeFeedback(h.db, created.id, recipeId, { rating: 4 });
  const before = await h.db.select().from(s.personRecipeFeedback);
  const markers = await h.db.select().from(s.syncState);
  await h.failWrite("people", "update", "profile_update_failure");
  await expect(saveHouseholdPerson(h.db, a, { ...profileInput, id: created.id, name: "Must not persist" })).rejects.toThrow();
  await h.dropFailure("people", "profile_update_failure");
  await h.failWrite("people", "delete", "profile_delete_failure");
  await expect(deleteHouseholdPerson(h.db, a, created.id)).rejects.toThrow();
  expect(await h.db.select().from(s.personRecipeFeedback)).toEqual(before);
  expect(await h.db.select().from(s.syncState)).toEqual(markers);
  expect(await householdPerson(h.db, a, created.id)).toMatchObject({ name: profileInput.name });
  await h.dropFailure("people", "profile_delete_failure");
  await deleteHouseholdPerson(h.db, a, created.id);
  expect(await householdPerson(h.db, a, created.id)).toBeUndefined();
  expect(await h.db.select().from(s.personRecipeFeedback)).toEqual([]);
  expect(await householdPerson(h.db, b, otherPerson)).toBeDefined();
});

it("projects only the selected household's account administration without credentials or invitation tokens", async () => {
  await h.db.insert(s.householdInvitations).values([
    { id: "local", householdId: "a", email: "local@example.test" },
    { id: "foreign", householdId: "b", email: "foreign@example.test" },
    { id: "expired", householdId: "a", email: "expired@example.test", createdAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000) },
    { id: "revoked", householdId: "a", email: "revoked@example.test", revokedAt: new Date() },
    { id: "accepted", householdId: "a", email: "accepted@example.test", acceptedAt: new Date() },
  ].map((row) => ({
    tokenHash: `secret-${row.id}`, invitedByUserId: row.householdId, expiresAt: new Date(Date.now() + 86400000), ...row,
  })));
  const result = await householdAccount(h.db, a);
  expect(result).toMatchObject({
    owner: true, profile: { id: a.personId }, profiles: [{ id: a.personId }],
    invitations: [{ id: "local", email: "local@example.test" }],
  });
  expect(result.members.map((member) => member.userId).sort()).toEqual(["a", "pending", "unverified"]);
  expect(result.members.find((member) => member.userId === "pending")?.profileName).toBeNull();
  expect(JSON.stringify(result)).not.toContain("secret-");
  expect(JSON.stringify(result)).not.toContain("foreign@example.test");
  expect((await householdAccount(h.db, b)).invitations).toEqual([{ id: "foreign", email: "foreign@example.test" }]);
});

it("withholds household member/email/invitation administration from members and refuses stale or incomplete scopes", async () => {
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  await expect(householdAccount(h.db, a)).rejects.toThrow("access changed");
  const member = await resolveHouseholdAccess(h.db, "a", "a");
  expect(await householdAccount(h.db, member)).toEqual({
    owner: false, profile: { id: a.personId, name: "Synthetic profile" }, profiles: [], invitations: [], members: [],
  });
  const pending = await resolveHouseholdAccess(h.db, "pending", "a");
  await expect(householdAccount(h.db, pending)).rejects.toThrow("Finish your household profile");
});
