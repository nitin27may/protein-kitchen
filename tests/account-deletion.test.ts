import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import * as s from "../lib/db/schema";
import { deleteOwnAccount } from "../lib/auth/household";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await openDb(); });
afterEach(async () => {
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });
const at = "2026-10-23T12:00:00.000Z";
const deleting = (id = "first") => ({
  userId: id, sessionToken: `${id}-token`, password: "synthetic-current-password",
  verifyPassword: vi.fn(async () => true),
});
async function fixture() {
  await h.db.insert(s.households).values({ id: "fixture", name: "Synthetic household" });
  const people = await h.db.insert(s.people).values(["first", "second"].map((id) => ({
    householdId: "fixture",
    name: `Synthetic ${id}`, sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light" as const, dietFlags: [],
  }))).returning();
  for (const [index, id] of ["first", "second"].entries()) {
    await h.db.insert(s.authUsers).values({ id, email: `${id}@example.test`, name: id, emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "fixture", userId: id, personId: people[index]!.id, role: "owner" });
    await h.db.insert(s.authAccounts).values({ id, userId: id, providerId: "credential", accountId: id, password: `${id}-hash`, updatedAt: new Date() });
    await h.db.insert(s.authSessions).values({ id, userId: id, token: `${id}-token`, updatedAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
    await h.db.insert(s.pushSubscriptions).values({
      personId: people[index]!.id, endpoint: `https://push.example.test/${id}`, p256dh: "synthetic", auth: "synthetic", createdAt: at,
    });
  }
  await h.db.insert(s.householdBootstrap).values({ id: 1, ownerUserId: "first", createdAt: new Date(at) });
  await h.db.insert(s.householdInvitations).values([
    { id: "issued", email: "pending@example.test", invitedByUserId: "first", tokenHash: "issued" },
    { id: "accepted", email: "first@example.test", invitedByUserId: "second", acceptedByUserId: "first", acceptedAt: new Date(), tokenHash: "accepted" },
    { id: "unrelated", email: "unrelated@example.test", invitedByUserId: "second", tokenHash: "unrelated" },
  ].map((row) => ({ ...row, householdId: "fixture", expiresAt: new Date(Date.now() + 86400000) })));
  await h.db.insert(s.authVerifications).values([
    ...["sign-in", "email-verification", "forget-password"].map((type) => ({ id: type, identifier: `${type}-otp-first@example.test`, value: "synthetic-hashed-code:0" })),
    { id: "link", identifier: "reset-password:synthetic", value: "first" },
    { id: "unrelated", identifier: "sign-in-otp-second@example.test", value: "synthetic-other-code:0" },
    { id: "same-value", identifier: "unrelated-identifier", value: "first" },
  ].map((row) => ({ ...row, expiresAt: new Date(Date.now() + 60000) })));
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "shared-bowl", name: "Shared bowl", kind: "recipe", family: "bowls", mealSlots: ["dinner"], cuisine: "global",
    servings: 2, prepMin: 1, activeMin: 1, totalMin: 1, equipment: [], tags: [], fridgeDays: 2, isIndian: false,
  }).returning();
  for (const person of people) await writePersonalRecipeFeedback(h.db, person.id, recipe!.id, { rating: 4, favourite: true, notes: "Shared notes remain" });
  const [setup] = await h.db.insert(s.planSetups).values({
    householdId: "fixture",
    personIds: people.map((p) => p.id), startDate: "2026-10-26", endDate: "2026-10-26", mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: at,
  }).returning();
  const [plan] = await h.db.insert(s.plans).values({ householdId: "fixture", setupId: setup!.id, seed: 42, createdAt: at }).returning();
  const [slot] = await h.db.insert(s.planSlots).values({ planId: plan!.id, date: "2026-10-26", slot: "dinner", recipeId: recipe!.id }).returning();
  await h.db.insert(s.planSlotPortions).values(people.map((person) => ({ personId: person.id, planSlotId: slot!.id, servings: 1 })));
  await h.db.insert(s.preferences).values({ personId: people[0]!.id, recipeId: recipe!.id, kind: "pin" });
  await h.db.insert(s.prepTaskState).values({ date: "2026-10-25", taskKey: "shared-prep", done: true });
  await h.db.insert(s.planProgress).values({ planId: plan!.id, step: "shopping", doneAt: at });
}
const snapshot = () => Promise.all(Object.values(s).map((table) => h.db.select().from(table)));

describe("atomic confirmed self-deletion", () => {
  it("never treats a verified owner of a different household as the deleting household's replacement", async () => {
    await fixture();
    await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "second"));
    await h.db.insert(s.households).values({ id: "foreign", name: "Other synthetic household" });
    const [person] = await h.db.insert(s.people).values({
      householdId: "foreign", name: "Foreign synthetic owner", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await h.db.insert(s.authUsers).values({ id: "foreign", name: "Foreign fixture", email: "foreign@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "foreign", userId: "foreign", role: "owner", personId: person!.id });
    const before = await snapshot();
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("at least one verified owner");
    expect(await snapshot()).toEqual(before);
  });

  it("removes only account-owned access and choices, preserving bootstrap tombstone and shared household data", async () => {
    await fixture();
    const retained = [s.people, s.preferences, s.planSetups, s.plans, s.planSlots, s.planSlotPortions, s.prepTaskState, s.planProgress, s.recipeFeedback];
    const before = await Promise.all(retained.map((table) => h.db.select().from(table)));
    const input = deleting();
    await deleteOwnAccount(h.db, input);
    expect(input.verifyPassword).toHaveBeenCalledExactlyOnceWith({ password: input.password, hash: "first-hash" });
    expect(await Promise.all(retained.map((table) => h.db.select().from(table)))).toEqual(before);
    for (const table of [s.authUsers, s.authAccounts, s.authSessions]) expect(await h.db.select().from(table)).toMatchObject([{ id: "second" }]);
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "second" }]);
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([{ id: 1, ownerUserId: null, createdAt: new Date(at) }]);
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ id: "unrelated" }]);
    expect((await h.db.select().from(s.authVerifications)).map((row) => row.id).sort()).toEqual(["same-value", "unrelated"]);
    expect(await h.db.select().from(s.pushSubscriptions)).toMatchObject([{ endpoint: "https://push.example.test/second" }]);
    expect(await h.db.select().from(s.personRecipeFeedback)).toMatchObject([{ personId: 2, rating: 4 }]);
    expect(await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, "personal-recipe-feedback"))).toHaveLength(1);
  });
  it("allows an incomplete member to delete their login without clearing any meal profile", async () => {
    await fixture();
    await h.db.update(s.householdMembers).set({ role: "member", personId: null }).where(eq(s.householdMembers.userId, "first"));
    await deleteOwnAccount(h.db, deleting());
    expect(await h.db.select().from(s.people)).toHaveLength(2);
    expect(await h.db.select().from(s.personRecipeFeedback)).toHaveLength(2);
  });
  it("refuses missing, unverified, removed, stale, expired and foreign sessions without writes", async () => {
    await fixture();
    await expect(deleteOwnAccount(h.db, deleting("unknown"))).rejects.toThrow("Verify your email");
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "first"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("Verify your email");
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "first"));
    const before = await snapshot();
    await expect(deleteOwnAccount(h.db, { ...deleting(), sessionToken: "second-token" })).rejects.toThrow("session has expired");
    expect(await snapshot()).toEqual(before);
    await h.db.update(s.authSessions).set({ expiresAt: new Date(0) }).where(eq(s.authSessions.userId, "first"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("session has expired");
    await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "first"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("no longer in the household");
  });
  it("requires an existing current credential and correct password before changing anything", async () => {
    await fixture();
    const before = await snapshot();
    await expect(deleteOwnAccount(h.db, { ...deleting(), verifyPassword: async () => false })).rejects.toThrow("current password is incorrect");
    expect(await snapshot()).toEqual(before);
    await h.db.update(s.authAccounts).set({ password: null }).where(eq(s.authAccounts.id, "first"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("current password is incorrect");
    await h.db.delete(s.authAccounts).where(eq(s.authAccounts.id, "first"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("current password is incorrect");
  });
  it("requires another verified owner with a completed profile, not just an owner flag", async () => {
    await fixture();
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "second"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("at least one verified owner");
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "second"));
    await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "second"));
    await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow("at least one verified owner");
  });
  it.each([
    ["push_subscriptions", "DELETE"], ["person_recipe_feedback", "DELETE"], ["sync_state", "UPDATE"],
    ["household_invitations", "DELETE"], ["auth_verifications", "DELETE"], ["auth_users", "DELETE"],
    ["auth_accounts", "DELETE"], ["auth_sessions", "DELETE"], ["household_members", "DELETE"], ["household_bootstrap", "UPDATE"],
  ])("rolls back all changes when %s %s fails", async (table, operation) => {
    await fixture();
    const before = await snapshot();
    await h.failWrite(table, operation, "reject_account_deletion");
    try {
      await expect(deleteOwnAccount(h.db, deleting())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally { await h.dropFailure(table, "reject_account_deletion"); }
  });
});
