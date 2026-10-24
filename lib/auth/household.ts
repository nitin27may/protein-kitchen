import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx, type Tx } from "../db/tx";
import { authAccounts, authSessions, authUsers, authVerifications, householdBootstrap, householdInvitations, householdMembers, households, people, pushSubscriptions } from "../db/schema";
import { deletePersonalFeedbackForPerson } from "../human/personal-feedback";
import { secretsMatch, tokenHash } from "./tokens";
import { PersonInput, personRow, type PersonInputData } from "../schemas/person";

export class HouseholdAccessError extends Error {
  override name = "HouseholdAccessError";
}

const pending = () => and(isNull(householdInvitations.acceptedAt), isNull(householdInvitations.revokedAt));
const emailSchema = z.string().trim().toLowerCase().email().max(254);

// One deployment-wide lock also covers the not-yet-created bootstrap row.
async function lockHousehold(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(20261024, 15)`);
}

async function verifiedUser(tx: Tx, userId: string) {
  const [user] = await tx.select().from(authUsers).where(eq(authUsers.id, userId)).for("update");
  if (!user?.emailVerified) throw new HouseholdAccessError("Verify your email before joining the household.");
  return user;
}

async function singleMembership(tx: Tx, userId: string) {
  const memberships = await tx.select().from(householdMembers)
    .where(eq(householdMembers.userId, userId)).limit(2).for("update");
  if (memberships.length > 1) throw new HouseholdAccessError("Select a household before continuing.");
  return memberships[0];
}

async function requireOwner(tx: Tx, userId: string) {
  await verifiedUser(tx, userId);
  const member = await singleMembership(tx, userId);
  if (member?.role !== "owner" || member.householdId === null) throw new HouseholdAccessError("Only a household owner can manage invitations and profile links.");
  return { ...member, householdId: member.householdId };
}

async function availableProfile(tx: Tx, householdId: string, personId: number) {
  const [person] = await tx.select({ id: people.id }).from(people)
    .where(and(eq(people.id, personId), eq(people.householdId, householdId))).for("update");
  if (!person) throw new HouseholdAccessError("The selected profile no longer exists.");
  const [member] = await tx.select().from(householdMembers).where(eq(householdMembers.personId, personId));
  if (member) throw new HouseholdAccessError("That profile is already linked to a household account.");
}

async function requireAnotherOwner(tx: Tx, householdId: string, userId: string) {
  const [other] = await tx.select({ id: householdMembers.userId }).from(householdMembers)
    .innerJoin(authUsers, and(eq(authUsers.id, householdMembers.userId), eq(authUsers.emailVerified, true)))
    .innerJoin(people, and(eq(people.id, householdMembers.personId), eq(people.householdId, householdId)))
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, "owner"), ne(householdMembers.userId, userId), isNotNull(householdMembers.personId)))
    .limit(1);
  if (!other) throw new HouseholdAccessError("Keep at least one verified owner with a completed profile.");
}

export async function changeMemberRole(db: Db, actorUserId: string, targetUserId: string, role: "owner" | "member") {
  z.string().min(1).max(128).parse(targetUserId);
  z.enum(["owner", "member"]).parse(role);
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId);
    const [target] = await tx.select().from(householdMembers)
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId))).for("update");
    if (!target) throw new HouseholdAccessError("That account is no longer in the household.");
    if (target.role === role) return;
    if (role === "owner") {
      await verifiedUser(tx, targetUserId);
      if (target.personId === null) throw new HouseholdAccessError("Complete profile onboarding before making this account an owner.");
    } else {
      await requireAnotherOwner(tx, actor.householdId, targetUserId);
      await tx.update(householdInvitations).set({ revokedAt: new Date() })
        .where(and(pending(), eq(householdInvitations.householdId, actor.householdId), eq(householdInvitations.invitedByUserId, targetUserId)));
    }
    await tx.update(householdMembers).set({ role, updatedAt: new Date() })
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId)));
  });
}

export async function removeHouseholdMember(db: Db, actorUserId: string, targetUserId: string) {
  z.string().min(1).max(128).parse(targetUserId);
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId);
    const [target] = await tx.select().from(householdMembers)
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId))).for("update");
    if (!target) throw new HouseholdAccessError("That account is no longer in the household.");
    if (target.role === "owner") await requireAnotherOwner(tx, actor.householdId, targetUserId);
    if (target.personId !== null) await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.personId, target.personId));
    await tx.delete(authSessions).where(eq(authSessions.userId, targetUserId));
    await tx.update(householdInvitations).set({ revokedAt: new Date() })
      .where(and(pending(), eq(householdInvitations.householdId, actor.householdId), eq(householdInvitations.invitedByUserId, targetUserId)));
    await tx.delete(householdMembers)
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId)));
  });
}

/** Called only by the rate-limited auth HTTP endpoint with its authoritative session. */
export async function deleteOwnAccount(db: Db, input: {
  userId: string; sessionToken: string; password: string;
  verifyPassword: (input: { password: string; hash: string }) => Promise<boolean>;
}) {
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const user = await verifiedUser(tx, input.userId);
    const memberships = await tx.select().from(householdMembers)
      .where(eq(householdMembers.userId, user.id)).for("update");
    if (!memberships.length) throw new HouseholdAccessError("Your account is no longer in the household.");
    const ownedMemberships = memberships.map((member) => {
      if (member.householdId === null) throw new HouseholdAccessError("Your account is no longer in the household.");
      return { ...member, householdId: member.householdId };
    });
    const [session] = await tx.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.userId, user.id), eq(authSessions.token, input.sessionToken), gt(authSessions.expiresAt, new Date()),
    )).for("update");
    if (!session) throw new HouseholdAccessError("Your session has expired. Sign in again before deleting your account.");
    const [credential] = await tx.select({ password: authAccounts.password }).from(authAccounts)
      .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential"))).for("update");
    if (!credential?.password || !await input.verifyPassword({ password: input.password, hash: credential.password })) {
      throw new HouseholdAccessError("Your current password is incorrect. Try again.");
    }
    for (const member of ownedMemberships) {
      if (member.role === "owner") await requireAnotherOwner(tx, member.householdId, user.id);
    }
    for (const member of ownedMemberships) {
      if (member.personId !== null) {
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.personId, member.personId));
        await deletePersonalFeedbackForPerson(tx, member.personId);
      }
    }
    await tx.delete(householdInvitations).where(or(
      eq(householdInvitations.invitedByUserId, user.id), eq(householdInvitations.email, user.email),
      eq(householdInvitations.acceptedByUserId, user.id),
    ));
    await tx.delete(authVerifications).where(or(
      inArray(authVerifications.identifier, ["sign-in", "email-verification", "forget-password"].map((type) => `${type}-otp-${user.email}`)),
      and(like(authVerifications.identifier, "reset-password:%"), eq(authVerifications.value, user.id)),
    ));
    await tx.delete(authUsers).where(eq(authUsers.id, user.id));
  });
}

export async function createMemberProfile(db: Db, userId: string, input: PersonInputData) {
  const v = PersonInput.parse(input);
  if (v.id !== undefined) throw new HouseholdAccessError("Onboarding cannot overwrite an existing profile.");
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    await verifiedUser(tx, userId);
    const member = await singleMembership(tx, userId);
    if (!member || member.householdId === null) throw new HouseholdAccessError("Join the household before creating your profile.");
    if (member.personId !== null) throw new HouseholdAccessError("Your account already has a profile.");
    const [person] = await tx.insert(people).values({ ...personRow(v), householdId: member.householdId }).returning({ id: people.id });
    await tx.update(householdMembers).set({ personId: person!.id, updatedAt: new Date() })
      .where(and(eq(householdMembers.userId, userId), eq(householdMembers.householdId, member.householdId)));
    return person!;
  });
}

/** Server-only admission: userId must come from the authenticated session, never a form field. */
export async function claimHousehold(db: Db, userId: string, submittedSecret: string, configuredSecret: string | undefined) {
  if (!configuredSecret || configuredSecret.length < 32) {
    throw new Error("Household bootstrap requires a server-configured secret of at least 32 characters.");
  }
  if (!secretsMatch(submittedSecret, configuredSecret)) {
    throw new HouseholdAccessError("Invalid household claim.");
  }
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    await verifiedUser(tx, userId);
    if ((await tx.select().from(householdBootstrap).limit(1)).length ||
        (await tx.select().from(householdMembers).limit(1)).length) {
      throw new HouseholdAccessError("The household has already been claimed.");
    }
    const existing = await tx.select({ id: households.id }).from(households).limit(2);
    if (existing.length > 1) throw new HouseholdAccessError("Multiple households require an explicit operator migration before claiming.");
    const household = existing[0] ?? (await tx.insert(households).values({ id: randomUUID(), name: "Household" }).returning({ id: households.id }))[0]!;
    await tx.insert(householdBootstrap).values({ id: 1, ownerUserId: userId });
    const [member] = await tx.insert(householdMembers).values({ householdId: household.id, userId, role: "owner" }).returning();
    return member!;
  });
}

export async function issueInvitation(db: Db, actorUserId: string, input: { email: string; personId?: number }) {
  const email = emailSchema.parse(input.email);
  if (input.personId !== undefined) z.number().int().positive().parse(input.personId);
  const token = randomBytes(32).toString("base64url");
  const invitation = await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId);
    const [existing] = await tx.select({ id: householdMembers.userId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(sql`lower(trim(${authUsers.email})) = ${email}`);
    if (existing) throw new HouseholdAccessError("That account is already in the household.");
    const now = new Date();
    await tx.update(householdInvitations).set({ revokedAt: now }).where(and(
      pending(), eq(householdInvitations.householdId, actor.householdId), lte(householdInvitations.expiresAt, now),
    ));
    // A resend replaces the old email-bound token in the same transaction.
    await tx.update(householdInvitations).set({ revokedAt: now }).where(and(
      pending(), eq(householdInvitations.householdId, actor.householdId), eq(householdInvitations.email, email),
    ));
    if (input.personId !== undefined) {
      await availableProfile(tx, actor.householdId, input.personId);
      const [reserved] = await tx.select().from(householdInvitations)
        .where(and(pending(), eq(householdInvitations.personId, input.personId)));
      if (reserved) throw new HouseholdAccessError("That profile is reserved by another invitation.");
    }
    const [row] = await tx.insert(householdInvitations).values({
      householdId: actor.householdId, id: randomUUID(), email, tokenHash: tokenHash(token), invitedByUserId: actorUserId,
      personId: input.personId, createdAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    }).returning({ id: householdInvitations.id, email: householdInvitations.email, expiresAt: householdInvitations.expiresAt });
    return row!;
  });
  // Deliver outside the transaction; callers must surface delivery failure, never log the token.
  return { ...invitation, token };
}

export async function acceptInvitation(db: Db, userId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HouseholdAccessError("This invitation is invalid or no longer available.");
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const user = await verifiedUser(tx, userId);
    const [invitation] = await tx.select().from(householdInvitations)
      .where(eq(householdInvitations.tokenHash, tokenHash(token))).for("update");
    if (!invitation || invitation.acceptedAt || invitation.revokedAt ||
        invitation.expiresAt.getTime() <= Date.now() || invitation.email !== emailSchema.parse(user.email)) {
      throw new HouseholdAccessError("This invitation is invalid or no longer available.");
    }
    const owner = await requireOwner(tx, invitation.invitedByUserId);
    if (invitation.householdId !== owner.householdId) throw new HouseholdAccessError("This invitation is invalid or no longer available.");
    const [existing] = await tx.select().from(householdMembers).where(eq(householdMembers.userId, userId));
    if (existing) throw new HouseholdAccessError("Your account is already in the household.");
    if (invitation.personId !== null) await availableProfile(tx, owner.householdId, invitation.personId);
    const now = new Date();
    const [member] = await tx.insert(householdMembers).values({
      householdId: owner.householdId, userId, role: "member", personId: invitation.personId, createdAt: now, updatedAt: now,
    }).returning();
    await tx.update(householdInvitations).set({ acceptedAt: now, acceptedByUserId: userId })
      .where(eq(householdInvitations.id, invitation.id));
    return member!;
  });
}

export async function revokeInvitation(db: Db, actorUserId: string, invitationId: string) {
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId);
    const [revoked] = await tx.update(householdInvitations).set({ revokedAt: new Date() })
      .where(and(eq(householdInvitations.id, invitationId), eq(householdInvitations.householdId, actor.householdId), pending()))
      .returning({ id: householdInvitations.id });
    if (!revoked) throw new HouseholdAccessError("This invitation is no longer available.");
  });
}

/** Existing profile links require owner approval, not a member-submitted arbitrary person id. */
export async function assignMemberProfile(db: Db, actorUserId: string, targetUserId: string, personId: number) {
  z.number().int().positive().parse(personId);
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId);
    const [member] = await tx.select().from(householdMembers)
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId))).for("update");
    if (!member) throw new HouseholdAccessError("The selected account is not in the household.");
    if (member.personId === personId) return member;
    await availableProfile(tx, actor.householdId, personId);
    const [reserved] = await tx.select().from(householdInvitations).where(and(
      pending(), eq(householdInvitations.personId, personId), sql`${householdInvitations.expiresAt} > now()`,
    ));
    if (reserved) throw new HouseholdAccessError("That profile is reserved by an invitation.");
    const [updated] = await tx.update(householdMembers).set({ personId, updatedAt: new Date() })
      .where(and(eq(householdMembers.userId, targetUserId), eq(householdMembers.householdId, actor.householdId))).returning();
    return updated!;
  });
}
