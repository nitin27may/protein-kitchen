import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as s from "../lib/db/schema";
import {
  acceptInvitation, assignMemberProfile, changeMemberRole, claimHousehold, claimHouseholdByOwnerEmail, createMemberProfile, deleteOwnAccount, issueInvitation, removeHouseholdMember, revokeInvitation,
} from "../lib/auth/household";
import { openDb, type DbHandle } from "./helpers/db";
import { exportHumanData } from "../lib/human/export";
import { resolveHouseholdAccess } from "../lib/auth/household-access";

let h: DbHandle;
const bootstrapSecret = "synthetic-bootstrap-secret-for-tests-only";
beforeAll(async () => { h = await openDb(); });
afterEach(async () => {
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

async function user(id = "owner", email = `${id}@example.test`, verified = true) {
  await h.db.insert(s.authUsers).values({ id, name: `Synthetic ${id}`, email, emailVerified: verified });
  return id;
}
async function owner() {
  const id = await user();
  await claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret);
  return id;
}
async function ownerHouseholdId() {
  const [member] = await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "owner"));
  if (!member?.householdId) throw new Error("Expected an owned synthetic household.");
  return member.householdId;
}
async function profile() {
  const [person] = await h.db.insert(s.people).values({
    householdId: await ownerHouseholdId(),
    name: "Synthetic meal profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", dietFlags: ["vegetarian"],
  }).returning();
  return person!.id;
}
async function otherHousehold() {
  await h.db.insert(s.households).values({ id: "foreign-household", name: "Other synthetic household" });
  await user("foreign-owner");
  const [person] = await h.db.insert(s.people).values({
    householdId: "foreign-household", name: "Foreign synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  await h.db.insert(s.householdMembers).values({
    householdId: "foreign-household", userId: "foreign-owner", personId: person!.id, role: "owner",
  });
  return person!.id;
}

async function cooks() {
  await owner();
  await assignMemberProfile(h.db, "owner", "owner", await profile());
  await user("cook");
  const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test", personId: await profile() });
  await acceptInvitation(h.db, "cook", invitation.token);
}
async function ownerDevices() {
  await cooks();
  await changeMemberRole(h.db, "owner", "cook", "owner");
  const [cook] = await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"));
  await h.db.insert(s.authSessions).values({
    id: "synthetic-session", userId: "cook", token: "synthetic-token", updatedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
  });
  await h.db.insert(s.pushSubscriptions).values({
    personId: cook!.personId!, endpoint: "https://push.example.test/cook-device", p256dh: "synthetic-key", auth: "synthetic-auth", createdAt: new Date().toISOString(),
  });
  await issueInvitation(h.db, "cook", { email: "next@example.test" });
}

async function additionalMembership(userId: string, role: "owner" | "member" = "member") {
  await otherHousehold();
  const [person] = await h.db.insert(s.people).values({
    householdId: "foreign-household", name: "Second membership profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  const [membership] = await h.db.insert(s.householdMembers).values({
    householdId: "foreign-household", userId, personId: person!.id, role,
  }).returning();
  return membership!;
}

describe("owner role and household access management", () => {
  it("refuses a supplied capability for another actor or a changed role before any management writes", async () => {
    await cooks();
    const access = await resolveHouseholdAccess(h.db, "owner", await ownerHouseholdId());
    const before = await h.db.select().from(s.householdMembers);
    await expect(issueInvitation(h.db, "cook", { email: "next@example.test" }, access)).rejects.toThrow("access changed");
    await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "owner"));
    await expect(changeMemberRole(h.db, "owner", "cook", "owner", access)).rejects.toThrow("access changed");
    await expect(assignMemberProfile(h.db, "owner", "cook", await profile(), access)).rejects.toThrow("access changed");
    expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, "next@example.test"))).toEqual([]);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook")))
      .toEqual(before.filter((member) => member.userId === "cook"));
  });
  it("accepts an invitation issued by an owner with multiple memberships without guessing the issuer household", async () => {
    await owner();
    const access = await resolveHouseholdAccess(h.db, "owner", await ownerHouseholdId());
    await additionalMembership("owner");
    await user("recipient");
    const invitation = await issueInvitation(h.db, "owner", { email: "recipient@example.test" }, access);
    await acceptInvitation(h.db, "recipient", invitation.token);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "recipient")))
      .toMatchObject([{ householdId: access.householdId, role: "member" }]);
  });
  it("refuses ambiguous actor management and profile onboarding rather than selecting a membership", async () => {
    await cooks();
    await additionalMembership("owner");
    const before = await h.db.select().from(s.householdMembers);
    await expect(issueInvitation(h.db, "owner", { email: "next@example.test" })).rejects.toThrow("Select a household");
    await expect(changeMemberRole(h.db, "owner", "cook", "owner")).rejects.toThrow("Select a household");
    await expect(removeHouseholdMember(h.db, "owner", "cook")).rejects.toThrow("Select a household");
    await expect(assignMemberProfile(h.db, "owner", "cook", await profile())).rejects.toThrow("Select a household");
    await expect(createMemberProfile(h.db, "owner", {
      name: "Synthetic profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
    })).rejects.toThrow("Select a household");
    expect(await h.db.select().from(s.householdMembers)).toEqual(before);
  });
  it("changes only the selected household role when the target has another membership", async () => {
    await cooks();
    const foreign = await additionalMembership("cook");
    await changeMemberRole(h.db, "owner", "cook", "owner");
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, foreign.householdId!)))
      .toContainEqual(foreign);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, await ownerHouseholdId())))
      .toContainEqual(expect.objectContaining({ userId: "cook", role: "owner" }));
  });
  it("changes only the selected household profile link when the target has another membership", async () => {
    await cooks();
    const foreign = await additionalMembership("cook");
    const personId = await profile();
    await assignMemberProfile(h.db, "owner", "cook", personId);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, "foreign-household")))
      .toContainEqual(foreign);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, await ownerHouseholdId())))
      .toContainEqual(expect.objectContaining({ userId: "cook", personId }));
  });
  it("removes only one membership and its devices while retaining the account and foreign devices", async () => {
    await ownerDevices();
    const foreign = await additionalMembership("cook");
    await h.db.insert(s.pushSubscriptions).values({
      personId: foreign.personId!, endpoint: "https://push.example.test/foreign-device", p256dh: "synthetic", auth: "synthetic", createdAt: new Date().toISOString(),
    });
    const profiles = await h.db.select().from(s.people);
    await removeHouseholdMember(h.db, "owner", "cook");
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"))).toEqual([foreign]);
    expect(await h.db.select().from(s.pushSubscriptions)).toMatchObject([{ personId: foreign.personId }]);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
    expect(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, "cook"))).toHaveLength(1);
    expect(await h.db.select().from(s.people)).toEqual(profiles);
  });
  it("checks every household's final owner before account-wide deletion and removes all linked devices on success", async () => {
    await ownerDevices();
    const foreign = await additionalMembership("cook", "owner");
    await h.db.insert(s.authAccounts).values({
      id: "synthetic-credential", userId: "cook", accountId: "cook", providerId: "credential", password: "synthetic-hash",
    });
    await h.db.insert(s.pushSubscriptions).values({
      personId: foreign.personId!, endpoint: "https://push.example.test/foreign-device", p256dh: "synthetic", auth: "synthetic", createdAt: new Date().toISOString(),
    });
    await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "foreign-owner"));
    const memberships = await h.db.select().from(s.householdMembers);
    const devices = await h.db.select().from(s.pushSubscriptions);
    const profiles = await h.db.select().from(s.people);
    const input = { userId: "cook", sessionToken: "synthetic-token", password: "synthetic", verifyPassword: async () => true };
    await expect(deleteOwnAccount(h.db, input)).rejects.toThrow("at least one verified owner");
    expect(await h.db.select().from(s.householdMembers)).toEqual(memberships);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual(devices);
    expect(await h.db.select().from(s.authSessions)).toHaveLength(1);
    await h.db.update(s.householdMembers).set({ role: "owner" }).where(eq(s.householdMembers.userId, "foreign-owner"));
    await deleteOwnAccount(h.db, input);
    expect(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, "cook"))).toEqual([]);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"))).toEqual([]);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual([]);
    expect(await h.db.select().from(s.people)).toEqual(profiles);
  });
  it("refuses account deletion for a verified account without membership", async () => {
    await user("unaffiliated");
    await expect(deleteOwnAccount(h.db, {
      userId: "unaffiliated", sessionToken: "unused", password: "unused", verifyPassword: async () => true,
    })).rejects.toThrow("no longer in the household");
  });
  it("refuses foreign member/profile/invitation management and does not count a foreign owner as a replacement", async () => {
    await cooks();
    const foreignPerson = await otherHousehold();
    const invitation = await issueInvitation(h.db, "foreign-owner", { email: "foreign-recipient@example.test" });
    const before = await h.db.select().from(s.householdMembers);
    await expect(changeMemberRole(h.db, "owner", "foreign-owner", "member")).rejects.toThrow("no longer in the household");
    await expect(removeHouseholdMember(h.db, "owner", "foreign-owner")).rejects.toThrow("no longer in the household");
    await expect(assignMemberProfile(h.db, "owner", "foreign-owner", await profile())).rejects.toThrow("not in the household");
    await expect(assignMemberProfile(h.db, "owner", "owner", foreignPerson)).rejects.toThrow("no longer exists");
    await expect(issueInvitation(h.db, "owner", { email: "next@example.test", personId: foreignPerson })).rejects.toThrow("no longer exists");
    await expect(revokeInvitation(h.db, "owner", invitation.id)).rejects.toThrow("no longer available");
    await expect(changeMemberRole(h.db, "owner", "owner", "member")).rejects.toThrow("at least one verified owner");
    await expect(removeHouseholdMember(h.db, "owner", "owner")).rejects.toThrow("at least one verified owner");
    expect(await h.db.select().from(s.householdMembers)).toEqual(before);
    expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, invitation.id)))
      .toMatchObject([{ id: invitation.id, revokedAt: null }]);
  });

  it("refuses unowned legacy membership for management, onboarding or deletion instead of guessing a household", async () => {
    await user("legacy");
    await h.db.insert(s.householdMembers).values({ userId: "legacy", role: "owner" });
    await expect(issueInvitation(h.db, "legacy", { email: "next@example.test" })).rejects.toThrow("Only a household owner");
    await expect(createMemberProfile(h.db, "legacy", {
      name: "Synthetic profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
    })).rejects.toThrow("Join the household");
    await expect(deleteOwnAccount(h.db, {
      userId: "legacy", sessionToken: "unused", password: "unused", verifyPassword: async () => true,
    })).rejects.toThrow("no longer in the household");
    expect(await h.db.select().from(s.households)).toEqual([]);
    expect(await h.db.select().from(s.people)).toEqual([]);
  });

  it("requires a verified owner, existing target and valid role without accepting escalation", async () => {
    await cooks();
    await expect(changeMemberRole(h.db, "cook", "cook", "owner")).rejects.toThrow("Only a household owner");
    await expect(removeHouseholdMember(h.db, "cook", "owner")).rejects.toThrow("Only a household owner");
    await expect(changeMemberRole(h.db, "unknown", "cook", "owner")).rejects.toThrow("Verify your email");
    await expect(changeMemberRole(h.db, "owner", "unknown", "member")).rejects.toThrow("no longer in the household");
    await expect(removeHouseholdMember(h.db, "owner", "unknown")).rejects.toThrow("no longer in the household");
    await expect(Reflect.apply(changeMemberRole, undefined, [h.db, "owner", "cook", "administrator"])).rejects.toThrow();
    await expect(removeHouseholdMember(h.db, "owner", "")).rejects.toThrow();
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"))).toMatchObject([{ role: "member" }]);
  });
  it("promotes only verified accounts with complete profiles and makes repeat assignments idempotent", async () => {
    await cooks();
    const before = await h.db.select().from(s.householdMembers);
    await changeMemberRole(h.db, "owner", "cook", "member");
    expect(await h.db.select().from(s.householdMembers)).toEqual(before);
    await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "cook"));
    await expect(changeMemberRole(h.db, "owner", "cook", "owner")).rejects.toThrow("Complete profile onboarding");
    await h.db.update(s.householdMembers).set({ personId: await profile() }).where(eq(s.householdMembers.userId, "cook"));
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "cook"));
    await expect(changeMemberRole(h.db, "owner", "cook", "owner")).rejects.toThrow("Verify your email");
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "cook"));
    await changeMemberRole(h.db, "owner", "cook", "owner");
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook"))).toMatchObject([{ role: "owner" }]);
  });
  it("preserves the final usable owner for demotion and removal", async () => {
    await cooks();
    await expect(changeMemberRole(h.db, "owner", "owner", "member")).rejects.toThrow("at least one verified owner");
    await expect(removeHouseholdMember(h.db, "owner", "owner")).rejects.toThrow("at least one verified owner");
    await changeMemberRole(h.db, "owner", "cook", "owner");
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "cook"));
    await expect(removeHouseholdMember(h.db, "owner", "owner")).rejects.toThrow("at least one verified owner");
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "cook"));
    await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "cook"));
    await expect(changeMemberRole(h.db, "owner", "owner", "member")).rejects.toThrow("at least one verified owner");
  });
  it("revokes pending invitations on demotion but retains the profile and sessions", async () => {
    await ownerDevices();
    const profiles = await h.db.select().from(s.people);
    await changeMemberRole(h.db, "owner", "cook", "member");
    expect(await h.db.select().from(s.people)).toEqual(profiles);
    expect(await h.db.select().from(s.authSessions)).toHaveLength(1);
    const [invitation] = await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, "next@example.test"));
    expect(invitation?.revokedAt).toBeInstanceOf(Date);
    await expect(issueInvitation(h.db, "cook", { email: "other@example.test" })).rejects.toThrow("Only a household owner");
  });
  it("removes sessions, device registrations and pending invitations without deleting profiles or credentials", async () => {
    await ownerDevices();
    const profiles = await h.db.select().from(s.people);
    const users = await h.db.select().from(s.authUsers);
    await removeHouseholdMember(h.db, "owner", "cook");
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", role: "owner" }]);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual([]);
    expect(await h.db.select().from(s.people)).toEqual(profiles);
    expect(await h.db.select().from(s.authUsers)).toEqual(users);
    const [invitation] = await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, "next@example.test"));
    expect(invitation?.revokedAt).toBeInstanceOf(Date);
  });
  it("can remove an incomplete member and the original owner after another owner is ready", async () => {
    await cooks();
    await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "cook"));
    await removeHouseholdMember(h.db, "owner", "cook");
    await h.db.insert(s.householdMembers).values({ householdId: await ownerHouseholdId(), userId: "cook", role: "member", personId: await profile() });
    await changeMemberRole(h.db, "owner", "cook", "owner");
    await removeHouseholdMember(h.db, "cook", "owner");
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "cook", role: "owner" }]);
    expect(await h.db.select().from(s.householdBootstrap)).toMatchObject([{ ownerUserId: "owner" }]);
  });
  it.each([
    ["push_subscriptions", "DELETE"], ["auth_sessions", "DELETE"], ["household_invitations", "UPDATE"], ["household_members", "DELETE"],
  ])("rolls back every removal side effect if %s fails", async (table, operation) => {
    await ownerDevices();
    const snapshot = async () => Promise.all([
      h.db.select().from(s.householdMembers), h.db.select().from(s.authSessions), h.db.select().from(s.pushSubscriptions), h.db.select().from(s.householdInvitations),
    ]);
    const before = await snapshot();
    await h.failWrite(table!, operation!, "reject_member_removal");
    try {
      await expect(removeHouseholdMember(h.db, "owner", "cook")).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally { await h.dropFailure(table!, "reject_member_removal"); }
    await removeHouseholdMember(h.db, "owner", "cook");
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
  });
  it("rolls back invitation revocation when a role change fails", async () => {
    await ownerDevices();
    await h.failWrite("household_members", "UPDATE", "reject_role_update");
    try {
      await expect(changeMemberRole(h.db, "owner", "cook", "member")).rejects.toThrow();
      expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, "next@example.test"))).toMatchObject([{ revokedAt: null }]);
    } finally { await h.dropFailure("household_members", "reject_role_update"); }
  });
});

describe("atomic member profile onboarding", () => {
  const input = {
    name: "Synthetic new cook", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light" as const, proteinMode: "per_kg" as const, proteinValue: 1.2, kcalTarget: null, reminderTime: null,
  };
  it("creates and links a profile once without generating a separate plan", async () => {
    await owner();
    const created = await createMemberProfile(h.db, "owner", input);
    expect(await h.db.select().from(s.people)).toMatchObject([{ id: created.id, proteinGPerKg: 1.2, proteinTargetG: null }]);
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", personId: created.id }]);
    await expect(createMemberProfile(h.db, "owner", input)).rejects.toThrow("already has a profile");
    expect(await h.db.select().from(s.people)).toHaveLength(1);
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });
  it("creates fixed targets for an admitted second cook without touching the owner's profile", async () => {
    await owner();
    const first = await createMemberProfile(h.db, "owner", input);
    await user("cook");
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await acceptInvitation(h.db, "cook", invitation.token);
    const second = await createMemberProfile(h.db, "cook", { ...input, name: "Second cook", proteinMode: "fixed", proteinValue: 95 });
    expect(second.id).not.toBe(first.id);
    expect(await h.db.select().from(s.people).where(eq(s.people.id, second.id))).toMatchObject([{ proteinGPerKg: null, proteinTargetG: 95 }]);
  });
  it("rejects unverified, unaffiliated, invalid and existing-profile submissions", async () => {
    await user("outsider");
    await user("unverified", "unverified@example.test", false);
    await expect(createMemberProfile(h.db, "unverified", input)).rejects.toThrow("Verify your email");
    await expect(createMemberProfile(h.db, "outsider", input)).rejects.toThrow("Join the household");
    await expect(createMemberProfile(h.db, "outsider", { ...input, id: 300 })).rejects.toThrow("cannot overwrite");
    await expect(createMemberProfile(h.db, "outsider", { ...input, proteinValue: 5 })).rejects.toThrow("between 0.6 and 3");
    expect(await h.db.select().from(s.people)).toEqual([]);
  });
  it("rolls back the new profile if linking fails, then retries without an orphan", async () => {
    await owner();
    await h.failWrite("household_members", "UPDATE", "reject_profile_link");
    try {
      await expect(createMemberProfile(h.db, "owner", input)).rejects.toThrow();
      expect(await h.db.select().from(s.people)).toEqual([]);
      expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ personId: null }]);
    } finally { await h.dropFailure("household_members", "reject_profile_link"); }
    expect(await createMemberProfile(h.db, "owner", input)).toHaveProperty("id");
  });
});

describe("one-time household bootstrap", () => {
  it("claims the single migrated household without changing its existing human data", async () => {
    await h.db.insert(s.households).values({ id: "migrated", name: "Existing household" });
    const id = await user();
    await h.db.insert(s.people).values({
      householdId: "migrated", name: "Existing synthetic profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    });
    const before = await h.db.select().from(s.people);
    expect(await claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).toMatchObject({ householdId: "migrated", personId: null });
    expect(await h.db.select().from(s.households)).toHaveLength(1);
    expect(await h.db.select().from(s.people)).toEqual(before);
  });
  it("refuses an ambiguous unclaimed target rather than selecting or merging households", async () => {
    await h.db.insert(s.households).values([{ id: "a", name: "A fixture" }, { id: "b", name: "B fixture" }]);
    const id = await user();
    await expect(claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).rejects.toThrow("explicit operator migration");
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
  });
  it("claims exactly one owner without creating meal profiles or plans", async () => {
    const id = await user();
    expect(await claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).toMatchObject({
      userId: id, role: "owner", personId: null, createdAt: expect.any(Date),
    });
    expect(await h.db.select().from(s.householdBootstrap)).toMatchObject([{ id: 1, ownerUserId: id }]);
    expect(await h.db.select().from(s.people)).toEqual([]);
    expect(await h.db.select().from(s.plans)).toEqual([]);
    await expect(claimHousehold(h.db, await user("second"), bootstrapSecret, bootstrapSecret)).rejects.toThrow("already been claimed");
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(1);
  });

  it.each([undefined, "short"])("refuses a missing/weak configured bootstrap secret", async (configured) => {
    await expect(claimHousehold(h.db, "unknown", bootstrapSecret, configured)).rejects.toThrow("server-configured secret");
  });

  it("refuses wrong secrets, unknown accounts and unverified email", async () => {
    await expect(claimHousehold(h.db, "unknown", "wrong", bootstrapSecret)).rejects.toThrow("Invalid household claim");
    await expect(claimHousehold(h.db, "unknown", bootstrapSecret, bootstrapSecret)).rejects.toThrow("Verify your email");
    await user("unverified", "unverified@example.test", false);
    await expect(claimHousehold(h.db, "unverified", bootstrapSecret, bootstrapSecret)).rejects.toThrow("Verify your email");
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
  });

  it("refuses an inconsistent pre-existing membership instead of granting another owner", async () => {
    const id = await user();
    await h.db.insert(s.householdMembers).values({ userId: id, role: "member" });
    await expect(claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).rejects.toThrow("already been claimed");
  });

  it.each(["households", "household_bootstrap", "household_members"])("rolls back household/bootstrap/membership together if %s fails, then retries", async (table) => {
    const id = await user();
    await h.failWrite(table, "INSERT", "reject_owner");
    try {
      await expect(claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).rejects.toThrow();
      expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
      expect(await h.db.select().from(s.households)).toEqual([]);
    } finally { await h.dropFailure(table, "reject_owner"); }
    expect(await claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).toMatchObject({ role: "owner" });
  });
});

describe("owner-email claim of the imported household", () => {
  it("binds the verified owner email to the memberless household and records bootstrap, once", async () => {
    await h.db.insert(s.households).values({ id: "migrated", name: "Existing household" });
    const id = await user("owner", "Owner@Example.test");
    expect(await claimHouseholdByOwnerEmail(h.db, id, "owner@example.test")).toMatchObject({ householdId: "migrated", role: "owner", personId: null });
    expect(await h.db.select().from(s.householdBootstrap)).toMatchObject([{ id: 1, ownerUserId: id }]);
    const second = await user("second");
    expect(await claimHouseholdByOwnerEmail(h.db, second, "second@example.test")).toBeNull();
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(1);
  });
  it.each([undefined, "", "not-an-email", "someone-else@example.test"])("returns null without claiming for owner email %j", async (configured) => {
    await h.db.insert(s.households).values({ id: "migrated", name: "Existing household" });
    const id = await user();
    expect(await claimHouseholdByOwnerEmail(h.db, id, configured)).toBeNull();
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
  });
  it("refuses an unverified email and never claims when bootstrap already exists", async () => {
    await h.db.insert(s.households).values({ id: "migrated", name: "Existing household" });
    await user("unverified", "unverified@example.test", false);
    await expect(claimHouseholdByOwnerEmail(h.db, "unverified", "unverified@example.test")).rejects.toThrow("Verify your email");
    const id = await user();
    await h.db.insert(s.authUsers).values({ id: "earlier", name: "Earlier", email: "earlier@example.test", emailVerified: true });
    await h.db.insert(s.householdBootstrap).values({ id: 1, ownerUserId: "earlier" });
    expect(await claimHouseholdByOwnerEmail(h.db, id, "owner@example.test")).toBeNull();
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
  });
  it("never claims for an account that already belongs to a household, even when an empty one exists", async () => {
    await h.db.insert(s.households).values([{ id: "migrated", name: "Existing household" }, { id: "own", name: "Own" }]);
    const id = await user("member-owner", "member-owner@example.test");
    await h.db.insert(s.householdMembers).values({ householdId: "own", userId: id, role: "owner" });
    expect(await claimHouseholdByOwnerEmail(h.db, id, "member-owner@example.test")).toBeNull();
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(1);
  });
  it("leaves a household that already has members alone", async () => {
    await owner();
    const id = await user("other-owner", "other-owner@example.test");
    expect(await claimHouseholdByOwnerEmail(h.db, id, "other-owner@example.test")).toBeNull();
  });
});

describe("email-bound, single-use invitations", () => {
  it("persists ownership through invitation, acceptance and profile onboarding", async () => {
    await owner();
    const householdId = await ownerHouseholdId();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await user("cook");
    expect(await acceptInvitation(h.db, "cook", invitation.token)).toMatchObject({ householdId });
    const person = await createMemberProfile(h.db, "cook", {
      name: "Synthetic profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
    });
    expect(await h.db.select().from(s.people)).toMatchObject([{ id: person.id, householdId }]);
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ householdId, acceptedByUserId: "cook" }]);
  });
  it("rejects an unowned or foreign-household invitation without consuming it", async () => {
    await owner();
    await otherHousehold();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await user("cook");
    for (const householdId of [null, "foreign-household"]) {
      await h.db.update(s.householdInvitations).set({ householdId }).where(eq(s.householdInvitations.id, invitation.id));
      await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("invalid or no longer available");
    }
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(2);
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ acceptedAt: null }]);
  });
  it("does not revoke expired associations in another household while issuing a local invitation", async () => {
    await owner();
    await otherHousehold();
    const invitation = await issueInvitation(h.db, "foreign-owner", { email: "foreign-recipient@example.test" });
    await h.db.update(s.householdInvitations).set({
      createdAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000),
    }).where(eq(s.householdInvitations.id, invitation.id));
    await issueInvitation(h.db, "owner", { email: "local-recipient@example.test" });
    expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, invitation.id)))
      .toMatchObject([{ householdId: "foreign-household", revokedAt: null }]);
  });
  it("joins a second cook to the existing household with a reserved existing profile", async () => {
    await owner();
    const personId = await profile();
    const invitation = await issueInvitation(h.db, "owner", { email: "  COOK@example.test ", personId });
    const [stored] = await h.db.select().from(s.householdInvitations);
    expect(invitation).toMatchObject({ email: "cook@example.test", token: expect.stringMatching(/^[\w-]{43}$/) });
    expect(stored).toMatchObject({ email: "cook@example.test", personId, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(stored)).not.toContain(invitation.token);
    await user("cook", "COOK@example.test");
    expect(await acceptInvitation(h.db, "cook", invitation.token)).toMatchObject({ userId: "cook", role: "member", personId });
    expect(await h.db.select().from(s.householdBootstrap)).toHaveLength(1);
    expect(await h.db.select().from(s.people)).toHaveLength(1);
    expect(await h.db.select().from(s.plans)).toEqual([]);
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ acceptedByUserId: "cook", acceptedAt: expect.any(Date) }]);
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("invalid or no longer available");
  });

  it("allows a member with no profile to proceed to onboarding", async () => {
    await owner();
    await user("cook");
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    expect(await acceptInvitation(h.db, "cook", invitation.token)).toMatchObject({ personId: null, role: "member" });
  });

  it("requires a verified owner to issue, revoke and assign profiles", async () => {
    await owner();
    await user("outsider");
    await expect(issueInvitation(h.db, "outsider", { email: "cook@example.test" })).rejects.toThrow("Only a household owner");
    await expect(revokeInvitation(h.db, "outsider", "missing")).rejects.toThrow("Only a household owner");
    await expect(assignMemberProfile(h.db, "outsider", "owner", 1)).rejects.toThrow("Only a household owner");
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "owner"));
    await expect(issueInvitation(h.db, "owner", { email: "cook@example.test" })).rejects.toThrow("Verify your email");
  });

  it("validates emails and profile ids before issuing", async () => {
    await expect(issueInvitation(h.db, "owner", { email: "invalid" })).rejects.toThrow();
    await expect(issueInvitation(h.db, "owner", { email: "cook@example.test", personId: -1 })).rejects.toThrow();
    await owner();
    await expect(issueInvitation(h.db, "owner", { email: "owner@example.test" })).rejects.toThrow("already in the household");
    await expect(issueInvitation(h.db, "owner", { email: "cook@example.test", personId: 999 })).rejects.toThrow("no longer exists");
  });

  it("rejects mismatched/unverified/missing accounts without consuming an invitation", async () => {
    await owner();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await user("wrong");
    await user("cook", "cook@example.test", false);
    await expect(acceptInvitation(h.db, "wrong", invitation.token)).rejects.toThrow("invalid or no longer available");
    await expect(acceptInvitation(h.db, "missing", invitation.token)).rejects.toThrow("Verify your email");
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("Verify your email");
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ acceptedAt: null }]);
  });

  it.each(["wrong", "x".repeat(43)])("refuses malformed or unknown tokens", async (token) => {
    await user("cook");
    await expect(acceptInvitation(h.db, "cook", token)).rejects.toThrow("invalid or no longer available");
  });

  it("refuses expired tokens and revokes expired reservations when issuing again", async () => {
    await owner();
    await user("cook");
    const personId = await profile();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test", personId });
    await h.db.update(s.householdInvitations).set({
      createdAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000),
    }).where(eq(s.householdInvitations.id, invitation.id));
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("invalid or no longer available");
    const replacement = await issueInvitation(h.db, "owner", { email: "replacement@example.test", personId });
    expect(replacement.id).not.toBe(invitation.id);
    expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, invitation.id)))
      .toMatchObject([{ revokedAt: expect.any(Date) }]);
  });

  it("replaces a resent token and explicitly revokes an outstanding invitation", async () => {
    await owner();
    await user("cook");
    const old = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    const replacement = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    expect(replacement.token).not.toBe(old.token);
    await expect(acceptInvitation(h.db, "cook", old.token)).rejects.toThrow("invalid or no longer available");
    await revokeInvitation(h.db, "owner", replacement.id);
    await expect(acceptInvitation(h.db, "cook", replacement.token)).rejects.toThrow("invalid or no longer available");
    await expect(revokeInvitation(h.db, "owner", replacement.id)).rejects.toThrow("no longer available");
    await expect(revokeInvitation(h.db, "owner", "missing")).rejects.toThrow("no longer available");
  });

  it("rejects an invitation whose inviter has lost ownership", async () => {
    await owner();
    await user("cook");
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "owner"));
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("Only a household owner");
  });

  it("does not replace an existing member's role or link", async () => {
    await owner();
    await user("cook");
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await h.db.insert(s.householdMembers).values({ householdId: await ownerHouseholdId(), userId: "cook", role: "member" });
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("already in the household");
  });

  it("rolls back both membership and consumption if the final invitation update fails", async () => {
    await owner();
    await user("cook");
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await h.failWrite("household_invitations", "UPDATE", "reject_accept");
    try {
      await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow();
      expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner" }]);
      expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ acceptedAt: null }]);
    } finally { await h.dropFailure("household_invitations", "reject_accept"); }
    expect(await acceptInvitation(h.db, "cook", invitation.token)).toMatchObject({ role: "member" });
  });

  it("rolls back token replacement when a later profile validation fails", async () => {
    await owner();
    const original = await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    await expect(issueInvitation(h.db, "owner", { email: "cook@example.test", personId: 999 })).rejects.toThrow("no longer exists");
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ id: original.id, revokedAt: null }]);
  });
});

describe("unique, explicitly approved meal profile links", () => {
  it("links an owner to an existing profile idempotently without duplicating the profile", async () => {
    await owner();
    const personId = await profile();
    const member = await assignMemberProfile(h.db, "owner", "owner", personId);
    expect(await assignMemberProfile(h.db, "owner", "owner", personId)).toEqual(member);
    expect(await h.db.select().from(s.people)).toHaveLength(1);
  });

  it("refuses missing targets, invalid/missing profiles and links owned by another cook", async () => {
    await owner();
    const personId = await profile();
    await assignMemberProfile(h.db, "owner", "owner", personId);
    await expect(assignMemberProfile(h.db, "owner", "missing", personId)).rejects.toThrow("not in the household");
    await expect(assignMemberProfile(h.db, "owner", "owner", 999)).rejects.toThrow("no longer exists");
    await expect(assignMemberProfile(h.db, "owner", "owner", 0)).rejects.toThrow();
    await expect(issueInvitation(h.db, "owner", { email: "cook@example.test", personId })).rejects.toThrow("already linked");
    await user("cook");
    await h.db.insert(s.householdMembers).values({ householdId: await ownerHouseholdId(), userId: "cook", role: "member" });
    await expect(assignMemberProfile(h.db, "owner", "cook", personId)).rejects.toThrow("already linked");
  });

  it("honours pending reservations when issuing or assigning another link", async () => {
    await owner();
    const personId = await profile();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test", personId });
    await expect(issueInvitation(h.db, "owner", { email: "another@example.test", personId })).rejects.toThrow("reserved");
    await expect(assignMemberProfile(h.db, "owner", "owner", personId)).rejects.toThrow("reserved");
    await revokeInvitation(h.db, "owner", invitation.id);
    expect(await assignMemberProfile(h.db, "owner", "owner", personId)).toMatchObject({ personId });
  });

  it("does not steal a profile linked since the invitation was issued", async () => {
    await owner();
    await user("cook");
    const personId = await profile();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test", personId });
    await h.db.update(s.householdMembers).set({ personId }).where(eq(s.householdMembers.userId, "owner"));
    await expect(acceptInvitation(h.db, "cook", invitation.token)).rejects.toThrow("already linked");
  });

  it("preserves an account when an unneeded meal profile is deleted", async () => {
    await owner();
    const personId = await profile();
    await assignMemberProfile(h.db, "owner", "owner", personId);
    await h.db.delete(s.people).where(eq(s.people.id, personId));
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", personId: null }]);
  });

  it("allows assignment after a reservation expires without modifying the expired token", async () => {
    await owner();
    const personId = await profile();
    const invitation = await issueInvitation(h.db, "owner", { email: "cook@example.test", personId });
    await h.db.update(s.householdInvitations).set({
      createdAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000),
    }).where(eq(s.householdInvitations.id, invitation.id));
    expect(await assignMemberProfile(h.db, "owner", "owner", personId)).toMatchObject({ personId });
    expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ revokedAt: null, acceptedAt: null }]);
  });

  it("keeps identity data and invitation tokens out of human-state exports", async () => {
    const before = await exportHumanData(h.db);
    await owner();
    await issueInvitation(h.db, "owner", { email: "cook@example.test" });
    expect(await exportHumanData(h.db)).toEqual(before);
  });
});

describe("installed Better Auth schema compatibility", () => {
  it("creates real password credentials and sessions using the generated mapped schema", async () => {
    const auth = betterAuth({
      database: drizzleAdapter(h.db, { provider: "pg", schema: s }),
      baseURL: "http://localhost:3112",
      secret: "synthetic-better-auth-test-secret-only-32chars",
      user: { modelName: "authUsers" }, session: { modelName: "authSessions" },
      account: { modelName: "authAccounts" }, verification: { modelName: "authVerifications" },
      emailAndPassword: { enabled: true },
    });
    const result = await auth.api.signUpEmail({ body: {
      name: "Synthetic account", email: "schema@example.test", password: "Synthetic-password-123!",
    } });
    expect(result.user).toMatchObject({ email: "schema@example.test", emailVerified: false });
    expect(await h.db.select().from(s.authSessions)).toHaveLength(1);
    const [account] = await h.db.select().from(s.authAccounts);
    expect(account).toMatchObject({ providerId: "credential", userId: result.user.id, createdAt: expect.any(Date) });
    expect(account!.password).not.toContain("Synthetic-password");
    const signedIn = await auth.api.signInEmail({ body: {
      email: "schema@example.test", password: "Synthetic-password-123!",
    } });
    expect(signedIn.user.id).toBe(result.user.id);
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
    expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
  });

  it("enforces normalized identity, singleton bootstrap, valid roles and unique profile links in SQL", async () => {
    await user();
    await expect(user("duplicate", "OWNER@example.test")).rejects.toThrow();
    await expect(h.db.insert(s.householdBootstrap).values({ id: 2, ownerUserId: "owner" })).rejects.toThrow();
    await expect(h.db.execute(sql`insert into household_members (user_id, role) values ('owner', 'admin')`)).rejects.toThrow();
    await claimHousehold(h.db, "owner", bootstrapSecret, bootstrapSecret);
    const personId = await profile();
    await assignMemberProfile(h.db, "owner", "owner", personId);
    await user("cook");
    await issueInvitation(h.db, "owner", { email: "pending@example.test" });
    await expect(h.db.delete(s.authUsers).where(eq(s.authUsers.id, "owner"))).rejects.toThrow();
    await expect(h.db.insert(s.householdMembers).values({ userId: "cook", role: "member", personId })).rejects.toThrow();
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(1);
  });
});
