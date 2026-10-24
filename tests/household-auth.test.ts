import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as s from "../lib/db/schema";
import {
  acceptInvitation, assignMemberProfile, claimHousehold, createMemberProfile, issueInvitation, revokeInvitation,
} from "../lib/auth/household";
import { openDb, type DbHandle } from "./helpers/db";
import { exportHumanData } from "../lib/human/export";

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
async function profile() {
  const [person] = await h.db.insert(s.people).values({
    name: "Synthetic meal profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", dietFlags: ["vegetarian"],
  }).returning();
  return person!.id;
}

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

  it("rolls back the singleton claim if the owner membership insert fails, then retries", async () => {
    const id = await user();
    await h.failWrite("household_members", "INSERT", "reject_owner");
    try {
      await expect(claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).rejects.toThrow();
      expect(await h.db.select().from(s.householdBootstrap)).toEqual([]);
    } finally { await h.dropFailure("household_members", "reject_owner"); }
    expect(await claimHousehold(h.db, id, bootstrapSecret, bootstrapSecret)).toMatchObject({ role: "owner" });
  });
});

describe("email-bound, single-use invitations", () => {
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
    await h.db.insert(s.householdMembers).values({ userId: "cook", role: "member" });
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
    await h.db.insert(s.householdMembers).values({ userId: "cook", role: "member" });
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
    await expect(h.db.delete(s.authUsers).where(eq(s.authUsers.id, "owner"))).rejects.toThrow();
    const personId = await profile();
    await assignMemberProfile(h.db, "owner", "owner", personId);
    await user("cook");
    await expect(h.db.insert(s.householdMembers).values({ userId: "cook", role: "member", personId })).rejects.toThrow();
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(1);
  });
});
