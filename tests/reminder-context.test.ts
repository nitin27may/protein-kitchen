import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadData, type DataSet } from "../lib/data/load";
import * as s from "../lib/db/schema";
import { householdReminderTasks, reminderPeople } from "../lib/reminders/context";
import { nightKey } from "../lib/prep/night";
import type { Recipe } from "../lib/schemas";
import { persistNewPlan } from "../lib/server/plan-persistence";
import { dispatchReminders, sendToPerson } from "../lib/server/push";
import { getData, getDb } from "../lib/server/context";
import { openDb, type DbHandle } from "./helpers/db";

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

const date = "2026-11-02";
const tomorrow = "2026-11-03";
const now = new Date("2026-11-02T21:00:00Z");
const recipe = (slug: string, extra: Partial<Recipe> = {}): Recipe => ({
  slug, name: slug, kind: "recipe", family: "test", meal_slots: ["dinner"], cuisine: "test", is_indian: false,
  servings: 1, prep_min: 0, active_min: 5, total_min: 10, equipment: [], tags: [], fridge_days: 1, status: "draft",
  items: [{ ingredient: "synthetic", grams: 100 }], steps: [{ text: "Synthetic step", cue: "Ready" }],
  advance_prep: [{ kind: "soak", lead_hours: 12, grams: 100, instruction: `Soak ${slug}` }], ...extra,
});
const recipes = [
  recipe("first"), recipe("second"), recipe("component", { kind: "component" }),
  recipe("meal-with-part", { items: [{ component: "component", grams: 100 }], advance_prep: [] }),
  recipe("routine", { kind: "routine", family: "routines", meal_slots: [] }),
];
const data: DataSet = {
  ...loadData(process.cwd()),
  recipes: new Map(recipes.map((r) => [r.slug, r])),
  habits: [{
    slug: "routine-habit", title: "Synthetic routine", category: "routine_drink", evidence_grade: "practical",
    evidence_note: "Synthetic fixture", source_url: null, caution: null, default_on: false,
    routine: { recipe: "routine", time_of_day: "morning", default_days: [1, 2, 3, 4, 5, 6, 7] },
  }],
};
let h: DbHandle;
let recipeIds: Map<string, number>;
let habitId: number;

beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values(["a", "b"].map((householdId, i) => ({
    id: i + 1, householdId, name: householdId, sex: "other" as const, birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [], reminderTime: "21:00", reminderTimezone: "UTC",
  })));
  await h.db.insert(s.authUsers).values(["a", "b"].map((id) => ({
    id, name: id, email: `${id}@example.test`, emailVerified: true,
  })));
  await h.db.insert(s.householdMembers).values(["a", "b"].map((householdId, i) => ({
    householdId, userId: householdId, personId: i + 1, role: "owner" as const,
  })));
  await h.db.insert(s.authSessions).values(["a", "b", "another-a"].map((id) => ({
    id, userId: id === "another-a" ? "a" : id, token: id, expiresAt: new Date("2099-01-01"), updatedAt: now,
  })));
  const rows = await h.db.insert(s.recipes).values(recipes.map((r) => ({
    slug: r.slug, name: r.name, kind: r.kind, family: r.family, mealSlots: r.meal_slots, cuisine: r.cuisine,
    isIndian: r.is_indian, servings: r.servings, prepMin: r.prep_min, activeMin: r.active_min,
    totalMin: r.total_min, equipment: r.equipment, tags: r.tags, fridgeDays: r.fridge_days,
  }))).returning({ id: s.recipes.id, slug: s.recipes.slug });
  recipeIds = new Map(rows.map((r) => [r.slug, r.id]));
  const [habit] = await h.db.insert(s.habits).values({
    slug: "routine-habit", title: "Synthetic", category: "routine_drink", evidenceGrade: "practical",
    evidenceNote: "Synthetic fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  habitId = habit!.id;
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  provider.send.mockReset().mockResolvedValue({});
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic-public");
  vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic-private");
});
afterEach(() => vi.unstubAllEnvs());

async function plan(householdId = "a", slug = "first", personIds = [1], routinePersonId?: number) {
  return persistNewPlan(h.db, {
    setup: {
      householdId, personIds, startDate: date, endDate: tomorrow, mealTypes: ["dinner"], cuisineBalance: 0.5,
      maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true },
      prepStyle: "variety", createdAt: now.toISOString(),
    },
    seed: 42, slots: [{
      date: tomorrow, slot: "dinner", recipeSlug: slug, servings: { [householdId === "b" ? 2 : 1]: 1 }, locked: false, reasons: [],
    }],
    routines: routinePersonId === undefined ? [] : [{
      planId: 0, personId: routinePersonId, habitId, days: [2], timeOfDay: "morning", servings: 1,
    }],
    recipeIds,
  });
}

it("deduplicates active sessions and enumerates only verified household-owned profiles", async () => {
  expect((await reminderPeople(h.db, now)).map(({ person }) => person.id).sort()).toEqual([1, 2]);
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "b"));
  expect((await reminderPeople(h.db, now)).map(({ person }) => person.id)).toEqual([1]);
  await h.db.update(s.authSessions).set({ expiresAt: new Date(0) });
  expect(await reminderPeople(h.db, now)).toEqual([]);
});

it("excludes transitional null-owned and corrupt cross-household associations", async () => {
  await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "a"));
  await h.client.exec("ALTER TABLE household_members DISABLE TRIGGER ALL");
  await h.db.update(s.householdMembers).set({ householdId: "a" }).where(eq(s.householdMembers.userId, "b"));
  await h.client.exec("ALTER TABLE household_members ENABLE TRIGGER ALL");
  expect(await reminderPeople(h.db, now)).toEqual([]);
});

it("selects each household's latest plan, never the deployment's latest plan", async () => {
  expect(await householdReminderTasks(h.db, data, "a", date)).toEqual([]);
  await plan();
  await plan("a", "second");
  await plan("b", "first", [2]);
  expect(await householdReminderTasks(h.db, data, "a", date)).toEqual(["Soak second (100 g), for second"]);
  expect(await householdReminderTasks(h.db, data, "b", date)).toEqual(["Soak first (100 g), for first"]);
  expect(await householdReminderTasks(h.db, data, "missing", date)).toEqual([]);
});

it("reads only owned, completed ticks for the selected date without migrating or writing them", async () => {
  const id = await plan();
  const key = nightKey(id, date, "recipe", "first", 0);
  await h.db.insert(s.prepTaskState).values([
    { householdId: "b", date, taskKey: key, done: true },
    { householdId: "a", date, taskKey: `${date}:legacy`, done: true },
  ]);
  const before = await h.db.select().from(s.prepTaskState);
  expect(await householdReminderTasks(h.db, data, "a", date)).toHaveLength(1);
  expect(await h.db.select().from(s.prepTaskState)).toEqual(before);
  await h.db.update(s.prepTaskState).set({ householdId: "a", done: false }).where(eq(s.prepTaskState.taskKey, key));
  expect(await householdReminderTasks(h.db, data, "a", date)).toHaveLength(1);
  await h.db.update(s.prepTaskState).set({ done: true }).where(eq(s.prepTaskState.taskKey, key));
  expect(await householdReminderTasks(h.db, data, "a", date)).toEqual([]);
  expect(await householdReminderTasks(h.db, data, "a", tomorrow)).toEqual([]);
});

it.each([[], [1, 1], [2], [999]].map((ids) => [ids]))("refuses invalid selected profiles %j", async (personIds) => {
  await plan("a", "first", personIds);
  await expect(householdReminderTasks(h.db, data, "a", date)).rejects.toThrow("profiles outside its household");
});

it("refuses a corrupt latest setup instead of silently falling back to an older plan", async () => {
  await plan();
  const id = await plan();
  await h.client.exec("ALTER TABLE plans DISABLE TRIGGER ALL");
  const [row] = await h.db.select().from(s.plans).where(eq(s.plans.id, id));
  await h.client.exec("ALTER TABLE plan_setups DISABLE TRIGGER ALL");
  await h.db.update(s.planSetups).set({ householdId: "b" }).where(eq(s.planSetups.id, row!.setupId));
  await h.client.exec("ALTER TABLE plan_setups ENABLE TRIGGER ALL; ALTER TABLE plans ENABLE TRIGGER ALL");
  await expect(householdReminderTasks(h.db, data, "a", date)).rejects.toThrow("setup is outside");
});

it("refuses foreign portions and foreign routine snapshots before building any message", async () => {
  const id = await plan();
  const [slot] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, id));
  await h.db.insert(s.planSlotPortions).values({ planSlotId: slot!.id, personId: 2, servings: 1 });
  await expect(householdReminderTasks(h.db, data, "a", date)).rejects.toThrow("portions or routines");
  await h.db.delete(s.planSlotPortions).where(eq(s.planSlotPortions.personId, 2));
  await plan("a", "first", [1], 2);
  await expect(householdReminderTasks(h.db, data, "a", date)).rejects.toThrow("portions or routines");
});

it("reuses part modes and routine snapshots when deriving the household's tasks", async () => {
  const id = await plan("a", "meal-with-part", [1], 1);
  expect(await householdReminderTasks(h.db, data, "a", date)).toEqual([
    "Soak component (100 g), for component", "Soak routine, for routine",
  ]);
  await h.db.insert(s.planPartState).values({ planId: id, componentSlug: "component", mode: "have", updatedAt: now.toISOString() });
  expect(await householdReminderTasks(h.db, data, "a", date)).toEqual(["Soak routine, for routine"]);
});

it("uses valid batch prep weekdays and treats invalid legacy values like the planner", async () => {
  const id = await plan();
  const [saved] = await h.db.select().from(s.plans).where(eq(s.plans.id, id));
  for (const prepDay of [2, 0]) {
    await h.db.update(s.planSetups).set({ prepDay, prepStyle: "batch" }).where(eq(s.planSetups.id, saved!.setupId));
    expect(await householdReminderTasks(h.db, data, "a", date)).toEqual(["Soak first (100 g), for first"]);
  }
});

it("dispatches each household's own task text to its devices and never repeats a frozen send", async () => {
  await plan();
  await plan("b", "second", [2]);
  await h.db.insert(s.pushSubscriptions).values([1, 2].map((personId) => ({
    personId, endpoint: `https://push.example.test/${personId}`, p256dh: "synthetic", auth: "synthetic", createdAt: now.toISOString(),
  })));
  expect(await dispatchReminders(now)).toMatchObject({ sent: 2 });
  expect(provider.send).toHaveBeenCalledTimes(2);
  const messages = new Map(provider.send.mock.calls.map(([sub, json]) => [sub.endpoint, JSON.parse(json).body]));
  expect(messages.get("https://push.example.test/1")).toContain("Soak first");
  expect(messages.get("https://push.example.test/1")).not.toContain("Soak second");
  expect(messages.get("https://push.example.test/2")).toContain("Soak second");
  expect(messages.get("https://push.example.test/2")).not.toContain("Soak first");
  expect(await dispatchReminders(now)).toMatchObject({ sent: 0 });
  expect(provider.send).toHaveBeenCalledTimes(2);
});

it("refuses manual test sends for a null-owned membership", async () => {
  await h.db.insert(s.pushSubscriptions).values({
    personId: 1, endpoint: "https://push.example.test/1", p256dh: "synthetic", auth: "synthetic", createdAt: now.toISOString(),
  });
  await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "a"));
  expect(await sendToPerson(1, { title: "Synthetic", body: "Synthetic", url: "/" })).toMatchObject({ sent: 0 });
  expect(provider.send).not.toHaveBeenCalled();
});
