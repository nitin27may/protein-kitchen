import { and, eq, getTableName, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import * as s from "../lib/db/schema";
import { memberHouseholdAccess, refreshHouseholdAccess } from "../lib/auth/household-access";
import { createSessionHousehold, resolveSessionHouseholdAccess, selectSessionHousehold, sessionHouseholds, type SessionIdentity } from "../lib/auth/household-session";
import { createMemberProfile } from "../lib/auth/household";
import { mutateHouseholdState } from "../lib/server/household-plans";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let firstPerson: number;
let secondPerson: number;
const identity = { userId: "cook", sessionId: "one" };
beforeAll(async () => { h = await openDb(); });
beforeEach(async () => {
  await h.db.insert(s.households).values([
    { id: "a", name: "First" }, { id: "b", name: "Second" }, { id: "foreign", name: "Private foreign name" },
  ]);
  await h.db.insert(s.authUsers).values(["cook", "other", "unverified"].map((id) => ({
    id, name: "Synthetic account", email: `${id}@example.test`, emailVerified: id !== "unverified",
  })));
  const profiles = await h.db.insert(s.people).values(["a", "b", "foreign"].map((householdId) => ({
    householdId, name: "Synthetic profile", sex: "other" as const, birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  }))).returning({ id: s.people.id });
  firstPerson = profiles[0]!.id;
  secondPerson = profiles[1]!.id;
  await h.db.insert(s.householdMembers).values([
    { householdId: "a", userId: "cook", personId: firstPerson, role: "owner" },
    { householdId: "foreign", userId: "other", personId: profiles[2]!.id, role: "owner" },
  ]);
  await h.db.insert(s.authSessions).values(["one", "two", "other", "unverified", "expired"].map((id) => ({
    id, userId: ["other", "unverified"].includes(id) ? id : "cook", token: `synthetic-${id}`,
    updatedAt: new Date(), expiresAt: new Date(id === "expired" ? 0 : Date.now() + 60_000),
  })));
});
afterEach(async () => {
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

async function joinSecond(complete = false) {
  await h.db.insert(s.householdMembers).values({
    householdId: "b", userId: "cook", role: "member", personId: complete ? secondPerson : null,
  });
}

it("creates only a fresh selected household and leaves legacy rows, existing households and other sessions unchanged", async () => {
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "cook"));
  await h.db.insert(s.people).values({
    name: "Quarantined legacy person", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  });
  await h.db.insert(s.photos).values({ uid: "quarantined-photo", ingredientSlug: "fixture", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-10-24T12:00:00Z", updatedAt: "2026-10-24T12:00:00Z" });
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, equipment: [], tags: [], fridgeDays: 2,
  }).returning({ id: s.recipes.id });
  await h.db.insert(s.recipeFeedback).values({ recipeId: recipe!.id, notes: "Quarantined human note" });
  const [setup] = await h.db.insert(s.planSetups).values({ personIds: [firstPerson], startDate: "2026-10-26", endDate: "2026-11-01", mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: "2026-10-24T12:00:00Z" }).returning({ id: s.planSetups.id });
  await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: "2026-10-24T12:00:00Z" });
  const people = await h.db.select().from(s.people), photos = await h.db.select().from(s.photos);
  const feedback = await h.db.select().from(s.recipeFeedback), plans = await h.db.select().from(s.plans);
  const setups = await h.db.select().from(s.planSetups), sessions = await h.db.select().from(s.authSessions);
  const households = await h.db.select().from(s.households);
  const created = await createSessionHousehold(h.db, identity, "  New shared home  ");
  expect(created).toEqual({ householdId: expect.any(String), profileComplete: false });
  expect(await h.db.select().from(s.households).where(eq(s.households.id, created.householdId))).toMatchObject([{ name: "New shared home" }]);
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook")))
    .toMatchObject([{ householdId: created.householdId, role: "owner", personId: null }]);
  expect(await resolveSessionHouseholdAccess(h.db, identity)).toMatchObject({
    householdId: created.householdId, role: "owner", personId: null,
    session: { id: "one", householdId: created.householdId, selectionVersion: 1 },
  });
  expect(await h.db.select().from(s.people)).toEqual(people);
  expect(await h.db.select().from(s.photos)).toEqual(photos);
  expect(await h.db.select().from(s.recipeFeedback)).toEqual(feedback);
  expect(await h.db.select().from(s.plans)).toEqual(plans);
  expect(await h.db.select().from(s.planSetups)).toEqual(setups);
  for (const before of households) expect(await h.db.select().from(s.households).where(eq(s.households.id, before.id))).toEqual([before]);
  for (const before of sessions.filter((row) => row.id !== "one")) expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, before.id))).toEqual([before]);
  expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
  await expect(createSessionHousehold(h.db, { userId: "cook", sessionId: "two" }, "Duplicate")).rejects.toThrow("already has");
  const access = await resolveSessionHouseholdAccess(h.db, identity);
  const profile = await createMemberProfile(h.db, "cook", {
    name: "New profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light",
    proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
  }, access);
  expect(await h.db.select().from(s.people).where(eq(s.people.id, profile.id))).toMatchObject([{ householdId: created.householdId }]);
});

it.each(["", " ".repeat(3), "x".repeat(101)])("refuses invalid household name %j without writes", async (name) => {
  const before = await h.db.select().from(s.households);
  await expect(createSessionHousehold(h.db, identity, name)).rejects.toThrow();
  expect(await h.db.select().from(s.households)).toEqual(before);
});

it.each(["existing", "quarantined", "multiple"])("refuses %s membership instead of creating, claiming or moving a household", async (kind) => {
  if (kind === "quarantined") await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "cook"));
  if (kind === "multiple") await joinSecond();
  const before = await h.db.select().from(s.households), sessions = await h.db.select().from(s.authSessions);
  await expect(createSessionHousehold(h.db, identity, "New home")).rejects.toThrow("already has");
  expect(await h.db.select().from(s.households)).toEqual(before);
  expect(await h.db.select().from(s.authSessions)).toEqual(sessions);
});

it.each(["household_members", "auth_sessions"])("rolls back household creation when %s persistence fails", async (table) => {
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "cook"));
  const before = await h.db.select().from(s.households), sessions = await h.db.select().from(s.authSessions);
  await h.failWrite(table, table === "auth_sessions" ? "UPDATE" : "INSERT", "fail_create");
  await expect(createSessionHousehold(h.db, identity, "New home")).rejects.toThrow();
  expect(await h.db.select().from(s.households)).toEqual(before);
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"))).toEqual([]);
  expect(await h.db.select().from(s.authSessions)).toEqual(sessions);
  await h.dropFailure(table, "fail_create");
});

it("resolves exactly one membership without changing the provider session and preserves binding on refresh", async () => {
  const sessions = await h.db.select().from(s.authSessions);
  const access = await resolveSessionHouseholdAccess(h.db, identity);
  expect(access).toMatchObject({
    householdId: "a", userId: "cook", personId: firstPerson, role: "owner",
    session: { id: "one", householdId: null, selectionVersion: 0 },
  });
  expect(Object.isFrozen(access)).toBe(true);
  expect(Object.isFrozen(access.session)).toBe(true);
  expect(await refreshHouseholdAccess(h.db, access)).toEqual(access);
  expect(await h.db.select().from(s.authSessions)).toEqual(sessions);
  expect(await sessionHouseholds(h.db, identity)).toEqual({
    households: [{ id: "a", name: "First", role: "owner", personId: firstPerson }],
    selectedHouseholdId: null, selectionUnavailable: false,
  });
});

it.each([false, true])("requires explicit selection with two memberships and never moves profiles; second profile complete: %s", async (complete) => {
  await joinSecond(complete);
  const profiles = await h.db.select().from(s.people);
  const memberships = await h.db.select().from(s.householdMembers);
  const sessions = await h.db.select().from(s.authSessions);
  await expect(resolveSessionHouseholdAccess(h.db, identity)).rejects.toThrow("Select an available household");
  const listed = await sessionHouseholds(h.db, identity);
  expect(listed.households).toEqual([
    { id: "a", name: "First", role: "owner", personId: firstPerson },
    { id: "b", name: "Second", role: "member", personId: complete ? secondPerson : null },
  ]);
  expect(listed.selectedHouseholdId).toBeNull();
  expect(await selectSessionHousehold(h.db, identity, "b")).toEqual({ householdId: "b", profileComplete: complete });
  const selected = await resolveSessionHouseholdAccess(h.db, identity);
  expect(selected).toMatchObject({
    householdId: "b", role: "member", personId: complete ? secondPerson : null,
    session: { id: "one", householdId: "b", selectionVersion: 1 },
  });
  expect(await refreshHouseholdAccess(h.db, selected)).toEqual(selected);
  expect((await sessionHouseholds(h.db, identity)).selectedHouseholdId).toBe("b");
  expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, "two"))).toEqual(sessions.filter((session) => session.id === "two"));
  const [current] = await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, "one"));
  expect(current).toMatchObject({
    token: "synthetic-one", expiresAt: sessions.find((session) => session.id === "one")!.expiresAt,
    householdSelectionVersion: 1,
  });
  expect(await h.db.select().from(s.people)).toEqual(profiles);
  expect(await h.db.select().from(s.householdMembers)).toEqual(memberships);
});

it("keeps repeated selection idempotent and isolates simultaneous sessions of the same account", async () => {
  await joinSecond();
  await selectSessionHousehold(h.db, identity, "a");
  const before = await h.db.select().from(s.authSessions);
  await selectSessionHousehold(h.db, identity, "a");
  expect(await h.db.select().from(s.authSessions)).toEqual(before);
  await selectSessionHousehold(h.db, { userId: "cook", sessionId: "two" }, "b");
  expect(await resolveSessionHouseholdAccess(h.db, identity)).toMatchObject({ householdId: "a" });
  expect(await resolveSessionHouseholdAccess(h.db, { userId: "cook", sessionId: "two" })).toMatchObject({ householdId: "b" });
});

it("preserves the request capability and refuses mismatched account, role, profile or stale session metadata", async () => {
  const access = await resolveSessionHouseholdAccess(h.db, identity);
  const member = { userId: "cook", role: "owner" as const, personId: firstPerson, householdAccess: access };
  expect(await memberHouseholdAccess(h.db, member)).toEqual(access);
  for (const mismatch of [
    { ...member, userId: "other" }, { ...member, role: "member" as const }, { ...member, personId: secondPerson },
  ]) {
    await expect(memberHouseholdAccess(h.db, mismatch)).rejects.toThrow("access changed");
  }
  await selectSessionHousehold(h.db, identity, "a");
  await expect(memberHouseholdAccess(h.db, member)).rejects.toThrow("session changed");
});

it.each([
  [{ userId: "missing", sessionId: "one" }, "verified account"],
  [{ userId: "unverified", sessionId: "unverified" }, "verified account"],
  [{ userId: "cook", sessionId: "other" }, "session has expired"],
  [{ userId: "cook", sessionId: "missing" }, "session has expired"],
  [{ userId: "cook", sessionId: "expired" }, "session has expired"],
])("refuses unavailable identity %j before reading or selecting a household", async (candidate: SessionIdentity, message) => {
  const sessions = await h.db.select().from(s.authSessions);
  await expect(sessionHouseholds(h.db, candidate)).rejects.toThrow(message);
  await expect(resolveSessionHouseholdAccess(h.db, candidate)).rejects.toThrow(message);
  await expect(selectSessionHousehold(h.db, candidate, "a")).rejects.toThrow(message);
  await expect(createSessionHousehold(h.db, candidate, "New home")).rejects.toThrow(message);
  expect(await h.db.select().from(s.authSessions)).toEqual(sessions);
});

it("does not fall back to another household after selected membership revocation", async () => {
  await joinSecond();
  await selectSessionHousehold(h.db, identity, "b");
  const access = await resolveSessionHouseholdAccess(h.db, identity);
  await h.db.delete(s.householdMembers).where(and(eq(s.householdMembers.userId, "cook"), eq(s.householdMembers.householdId, "b")));
  expect(await sessionHouseholds(h.db, identity)).toEqual({
    households: [{ id: "a", name: "First", role: "owner", personId: firstPerson }],
    selectedHouseholdId: null, selectionUnavailable: true,
  });
  await expect(resolveSessionHouseholdAccess(h.db, identity)).rejects.toThrow("not available");
  await expect(refreshHouseholdAccess(h.db, access)).rejects.toThrow("not available");
  await selectSessionHousehold(h.db, identity, "a");
  expect(await resolveSessionHouseholdAccess(h.db, identity)).toMatchObject({ householdId: "a" });
});

it("never selects or lists a foreign household, even with a valid verified session", async () => {
  const before = await h.db.select().from(s.authSessions);
  for (const householdId of ["foreign", "missing", ""]) {
    await expect(selectSessionHousehold(h.db, identity, householdId)).rejects.toThrow("not available");
  }
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "cook"));
  expect(await sessionHouseholds(h.db, identity)).toEqual({ households: [], selectedHouseholdId: null, selectionUnavailable: false });
  await expect(resolveSessionHouseholdAccess(h.db, identity)).rejects.toThrow("Select an available household");
  expect(await h.db.select().from(s.authSessions)).toEqual(before);
});

it.each(["expired", "deleted", "switched", "switched-back", "role", "profile", "unverified"])(
  "refuses stale session-bound mutation callbacks after %s", async (change) => {
    await joinSecond();
    await selectSessionHousehold(h.db, identity, "a");
    const initial = await resolveSessionHouseholdAccess(h.db, identity);
    const access = await refreshHouseholdAccess(h.db, initial);
    if (change === "expired") await h.db.update(s.authSessions).set({ expiresAt: new Date(0) }).where(eq(s.authSessions.id, "one"));
    if (change === "deleted") await h.db.delete(s.authSessions).where(eq(s.authSessions.id, "one"));
    if (change === "switched" || change === "switched-back") {
      await selectSessionHousehold(h.db, identity, "b");
      if (change === "switched-back") await selectSessionHousehold(h.db, identity, "a");
    }
    if (change === "role") await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.householdId, "a"));
    if (change === "profile") await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.householdId, "a"));
    if (change === "unverified") await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "cook"));
    let called = false;
    await expect(mutateHouseholdState(h.db, access, async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
  },
);

it("rejects new ambiguity in the implicit single-household selection and preserves transactional rollback", async () => {
  const implicit = await resolveSessionHouseholdAccess(h.db, identity);
  await joinSecond();
  await expect(mutateHouseholdState(h.db, implicit, async () => "not permitted")).rejects.toThrow("Select an available household");
  await selectSessionHousehold(h.db, identity, "a");
  const explicit = await resolveSessionHouseholdAccess(h.db, identity);
  await expect(mutateHouseholdState(h.db, explicit, async (tx) => {
    await tx.insert(s.savedViews).values({ householdId: "a", list: "recipes", name: "Must roll back", query: "" });
    throw new Error("Synthetic callback failure");
  })).rejects.toThrow("Synthetic callback failure");
  expect(await h.db.select().from(s.savedViews)).toEqual([]);
  expect(await mutateHouseholdState(h.db, explicit, async () => "saved")).toBe("saved");
});

it("rolls a failed session preference update back without changing session or membership", async () => {
  const before = await h.db.select().from(s.authSessions);
  await h.db.execute(sql`create function reject_session_selection() returns trigger language plpgsql as $$ begin raise exception 'Synthetic selection failure'; end $$`);
  await h.db.execute(sql`create trigger reject_session_selection before update on auth_sessions for each row execute function reject_session_selection()`);
  try {
    await expect(selectSessionHousehold(h.db, identity, "a")).rejects.toThrow();
    expect(await h.db.select().from(s.authSessions)).toEqual(before);
  } finally {
    await h.db.execute(sql`drop trigger reject_session_selection on auth_sessions`);
    await h.db.execute(sql`drop function reject_session_selection()`);
  }
  expect(await selectSessionHousehold(h.db, identity, "a")).toEqual({ householdId: "a", profileComplete: true });
  expect(await resolveSessionHouseholdAccess(h.db, identity)).toMatchObject({ session: { selectionVersion: 1 } });
});
