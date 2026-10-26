import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx, type Tx } from "../db/tx";
import { authAccounts, authSessions, authUsers, authVerifications, householdBootstrap, householdInvitations, householdMembers, households, people, pushSubscriptions } from "../db/schema";
import { deletePersonalFeedbackForPerson } from "../human/personal-feedback";
import { deleteHousehold } from "../human/reset";
import { consumeEmailCode } from "./email-code";
import { secretsMatch, tokenHash } from "./tokens";
import { PersonInput, personRow, type PersonInputData } from "../schemas/person";
import { refreshHouseholdAccess, resolveHouseholdAccess, type HouseholdAccess } from "./household-access";

export class HouseholdAccessError extends Error {
  override name = "HouseholdAccessError";
}

const pending = () => and(isNull(householdInvitations.acceptedAt), isNull(householdInvitations.declinedAt), isNull(householdInvitations.revokedAt));
const emailSchema = z.string().trim().toLowerCase().email().max(254);

// One deployment-wide lock also covers the not-yet-created bootstrap row.
export async function lockHousehold(tx: Tx) {
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

async function selectedMembership(tx: Tx, userId: string, access?: HouseholdAccess) {
  if (!access) return singleMembership(tx, userId);
  if (access.userId !== userId) throw new HouseholdAccessError("Your household access changed. Reload before continuing.");
  return refreshHouseholdAccess(tx, access);
}

async function requireOwner(tx: Tx, userId: string, access?: HouseholdAccess) {
  await verifiedUser(tx, userId);
  const member = await selectedMembership(tx, userId, access);
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

export const householdNameSchema = z.string().trim().min(1, "Enter a household name.").max(100, "Use at most 100 characters.");

/**
 * Renames one household. The actor must be an owner of exactly that household; the id is checked against
 * the actor's own membership row, so a guessed id from another household is indistinguishable from a missing one.
 */
export async function renameHousehold(db: Db, actorUserId: string, householdId: string, name: string) {
  const householdName = householdNameSchema.parse(name);
  z.string().min(1).max(128).parse(householdId);
  return withTx(db, async (tx) => {
    await verifiedUser(tx, actorUserId);
    const [member] = await tx.select().from(householdMembers)
      .where(and(eq(householdMembers.userId, actorUserId), eq(householdMembers.householdId, householdId))).for("update");
    if (!member) throw new HouseholdAccessError("This household is not available to your verified account.");
    if (member.role !== "owner") throw new HouseholdAccessError("Only a household owner can rename the household.");
    await tx.update(households).set({ name: householdName, updatedAt: new Date() }).where(eq(households.id, householdId));
    return { householdId, name: householdName };
  });
}

export async function changeMemberRole(db: Db, actorUserId: string, targetUserId: string, role: "owner" | "member", access?: HouseholdAccess) {
  z.string().min(1).max(128).parse(targetUserId);
  z.enum(["owner", "member"]).parse(role);
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
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

export async function removeHouseholdMember(db: Db, actorUserId: string, targetUserId: string, access?: HouseholdAccess) {
  z.string().min(1).max(128).parse(targetUserId);
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
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

/**
 * Re-authentication for account deletion: a fresh email code for the session's own address, or the current password for
 * an account that has one. Everything else about the request comes from the authoritative session.
 */
export type DeletionProof =
  | { code: string }
  | { password: string; verifyPassword: (input: { password: string; hash: string }) => Promise<boolean> };

/**
 * Called only by the rate-limited auth HTTP endpoint with its authoritative session.
 *
 * A household where the user is the only member is deleted with the account, in the same transaction: every household
 * table, every profile (birth date, weight), and the photo rows. The returned photo keys must be deleted from the blob
 * store by the caller after the commit. A household with other members is kept for them, and an owner there must hand
 * over ownership first.
 */
export async function deleteOwnAccount(db: Db, input: { userId: string; sessionToken: string } & DeletionProof): Promise<{ photoKeys: string[] }> {
  const outcome = await withTx(db, async (tx): Promise<{ photoKeys: string[] } | { refused: string }> => {
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
    const soleHouseholds: string[] = [];
    for (const member of ownedMemberships) {
      const [other] = await tx.select({ id: householdMembers.userId }).from(householdMembers)
        .where(and(eq(householdMembers.householdId, member.householdId), ne(householdMembers.userId, user.id))).limit(1);
      if (!other) { soleHouseholds.push(member.householdId); continue; }
      if (member.role === "owner") {
        try { await requireAnotherOwner(tx, member.householdId, user.id); }
        catch {
          throw new HouseholdAccessError("Transfer ownership first. Make another cook with a completed profile an owner, because at least one verified owner must stay in the household.");
        }
      }
    }
    if ("code" in input) {
      const checked = await consumeEmailCode(tx, user.email, input.code);
      if (!checked.ok) return { refused: checked.message };
    } else {
      const [credential] = await tx.select({ password: authAccounts.password }).from(authAccounts)
        .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential"))).for("update");
      if (!credential?.password || !await input.verifyPassword({ password: input.password, hash: credential.password })) {
        throw new HouseholdAccessError("Your current password is incorrect. Try again.");
      }
    }
    const photoKeys: string[] = [];
    for (const member of ownedMemberships) {
      if (soleHouseholds.includes(member.householdId)) {
        photoKeys.push(...await deleteHousehold(tx, member.householdId));
      } else if (member.personId !== null) {
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
      and(like(authVerifications.identifier, "magic-link:%"), sql`case
        when ${authVerifications.value} is json object
        then ${authVerifications.value}::jsonb ->> 'type' = 'magic-link'
          and lower(${authVerifications.value}::jsonb ->> 'email') = ${user.email}
        else false end`),
    ));
    await tx.delete(authUsers).where(eq(authUsers.id, user.id));
    return { photoKeys };
  });
  // A refused code still burned an attempt, so that write is committed above and the refusal is raised here.
  if ("refused" in outcome) throw new HouseholdAccessError(outcome.refused);
  return outcome;
}

export async function createMemberProfile(db: Db, userId: string, input: PersonInputData, access?: HouseholdAccess) {
  const v = PersonInput.parse(input);
  if (v.id !== undefined) throw new HouseholdAccessError("Onboarding cannot overwrite an existing profile.");
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    await verifiedUser(tx, userId);
    const member = await selectedMembership(tx, userId, access);
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

/**
 * Email proof replaces the claim secret: binds the verified owner email to the imported, memberless household.
 * Returns null (never throws) when the email does not match, bootstrap is already used, or there is no single
 * memberless household, so the caller falls through to automatic household creation. The configured email is
 * never logged or returned.
 */
export async function claimHouseholdByOwnerEmail(db: Db, userId: string, ownerEmail: string | undefined) {
  const configured = ownerEmail ? emailSchema.safeParse(ownerEmail) : null;
  if (!configured?.success) return null;
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const user = await verifiedUser(tx, userId);
    if (emailSchema.parse(user.email) !== configured.data) return null;
    if ((await tx.select().from(householdBootstrap).limit(1)).length) return null;
    if ((await tx.select().from(householdMembers).where(eq(householdMembers.userId, userId)).limit(1)).length) return null;
    const orphans = await tx.select({ id: households.id }).from(households)
      .leftJoin(householdMembers, eq(householdMembers.householdId, households.id))
      .where(isNull(householdMembers.userId)).limit(2);
    if (orphans.length !== 1) return null;
    await tx.insert(householdBootstrap).values({ id: 1, ownerUserId: userId });
    const [member] = await tx.insert(householdMembers).values({ householdId: orphans[0]!.id, userId, role: "owner" }).returning();
    return member!;
  });
}

export async function issueInvitation(db: Db, actorUserId: string, input: { email: string; personId?: number }, access?: HouseholdAccess) {
  const email = emailSchema.parse(input.email);
  if (input.personId !== undefined) z.number().int().positive().parse(input.personId);
  const token = randomBytes(32).toString("base64url");
  const invitation = await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
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

export async function addEmailAssociation(db: Db, actorUserId: string, input: {
  email: string; displayName?: string; relationship?: string;
}, access?: HouseholdAccess) {
  const email = emailSchema.parse(input.email);
  const displayName = input.displayName ? z.string().trim().min(1).max(60).parse(input.displayName) : null;
  const relationship = input.relationship ? z.string().trim().min(1).max(40).parse(input.relationship) : null;
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
    const [existing] = await tx.select({ id: householdMembers.userId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(and(eq(householdMembers.householdId, actor.householdId), sql`lower(trim(${authUsers.email})) = ${email}`));
    if (existing) throw new HouseholdAccessError("That account is already in this household.");
    const now = new Date();
    await tx.update(householdInvitations).set({ revokedAt: now }).where(and(
      pending(), eq(householdInvitations.householdId, actor.householdId), eq(householdInvitations.email, email),
      lte(householdInvitations.expiresAt, now),
    ));
    const [pendingAssociation] = await tx.select({ id: householdInvitations.id }).from(householdInvitations)
      .where(and(
        pending(), eq(householdInvitations.householdId, actor.householdId), eq(householdInvitations.email, email),
        gt(householdInvitations.expiresAt, now),
      ));
    if (pendingAssociation) throw new HouseholdAccessError("That email already has a pending association.");
    const [row] = await tx.insert(householdInvitations).values({
      householdId: actor.householdId, id: randomUUID(), email, tokenHash: null,
      invitedByUserId: actorUserId, personId: null, displayName, relationship,
      createdAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    }).returning({ id: householdInvitations.id, email: householdInvitations.email });
    return row!;
  });
}

export async function pendingEmailAssociations(db: Db, identity: { userId: string; sessionId: string }) {
  return withTx(db, async (tx) => {
    const user = await verifiedUser(tx, identity.userId);
    const [session] = await tx.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.id, identity.sessionId), eq(authSessions.userId, identity.userId), gt(authSessions.expiresAt, sql`now()`),
    ));
    if (!session) throw new HouseholdAccessError("Your session has expired. Sign in again before continuing.");
    return tx.select({
      id: householdInvitations.id, expiresAt: householdInvitations.expiresAt,
    }).from(householdInvitations).where(and(
      isNull(householdInvitations.tokenHash), eq(householdInvitations.email, emailSchema.parse(user.email)),
      pending(), gt(householdInvitations.expiresAt, sql`now()`),
    )).orderBy(householdInvitations.createdAt);
  });
}

export async function acceptEmailAssociation(db: Db, identity: { userId: string; sessionId: string }, invitationId: string) {
  z.string().min(1).max(128).parse(invitationId);
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const user = await verifiedUser(tx, identity.userId);
    const [session] = await tx.select().from(authSessions).where(and(
      eq(authSessions.id, identity.sessionId), eq(authSessions.userId, identity.userId), gt(authSessions.expiresAt, sql`now()`),
    )).for("update");
    if (!session) throw new HouseholdAccessError("Your session has expired. Sign in again before continuing.");
    const [invitation] = await tx.select().from(householdInvitations)
      .where(eq(householdInvitations.id, invitationId)).for("update");
    if (!invitation || invitation.tokenHash !== null || invitation.householdId === null ||
        invitation.email !== emailSchema.parse(user.email) || invitation.acceptedAt || invitation.declinedAt ||
        invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
      throw new HouseholdAccessError("This household association is no longer available.");
    }
    const [ownerMembership] = await tx.select({ userId: householdMembers.userId }).from(householdMembers)
      .where(and(
        eq(householdMembers.userId, invitation.invitedByUserId),
        eq(householdMembers.householdId, invitation.householdId),
        eq(householdMembers.role, "owner"),
      ));
    if (!ownerMembership) throw new HouseholdAccessError("This household association is no longer available.");
    await verifiedUser(tx, invitation.invitedByUserId);
    const existingMemberships = await tx.select().from(householdMembers)
      .where(eq(householdMembers.userId, identity.userId)).for("update");
    if (existingMemberships.some((membership) => membership.householdId === null)) {
      throw new HouseholdAccessError("Your legacy household membership needs an operator migration before joining another household.");
    }
    if (existingMemberships.some((membership) => membership.householdId === invitation.householdId)) {
      throw new HouseholdAccessError("This household association is no longer available.");
    }
    const now = new Date();
    const [member] = await tx.insert(householdMembers).values({
      householdId: invitation.householdId, userId: identity.userId, role: "member", personId: null, createdAt: now, updatedAt: now,
    }).returning();
    await tx.update(householdInvitations).set({ acceptedAt: now, acceptedByUserId: identity.userId })
      .where(eq(householdInvitations.id, invitation.id));
    const previousSelection = session.activeHouseholdId === null && existingMemberships.length === 1
      ? existingMemberships[0]!.householdId
      : session.activeHouseholdId;
    const selectionIsValid = previousSelection === null ||
      existingMemberships.some((membership) => membership.householdId === previousSelection);
    if (!selectionIsValid) throw new HouseholdAccessError("Choose an available household before accepting this association.");
    const nextSelection = previousSelection ?? (existingMemberships.length === 0 ? invitation.householdId : null);
    if (nextSelection !== session.activeHouseholdId) {
      await tx.update(authSessions).set({
        activeHouseholdId: nextSelection,
        householdSelectionVersion: sql`${authSessions.householdSelectionVersion} + 1`,
        updatedAt: now,
      }).where(eq(authSessions.id, session.id));
    }
    return member!;
  });
}

export async function declineEmailAssociation(db: Db, identity: { userId: string; sessionId: string }, invitationId: string) {
  z.string().min(1).max(128).parse(invitationId);
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const user = await verifiedUser(tx, identity.userId);
    const [session] = await tx.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.id, identity.sessionId), eq(authSessions.userId, identity.userId), gt(authSessions.expiresAt, sql`now()`),
    )).for("update");
    if (!session) throw new HouseholdAccessError("Your session has expired. Sign in again before continuing.");
    const [declined] = await tx.update(householdInvitations).set({ declinedAt: new Date() })
      .where(and(
        eq(householdInvitations.id, invitationId), isNull(householdInvitations.tokenHash),
        eq(householdInvitations.email, emailSchema.parse(user.email)), pending(),
        gt(householdInvitations.expiresAt, sql`now()`),
      )).returning({ id: householdInvitations.id });
    if (!declined) throw new HouseholdAccessError("This household association is no longer available.");
  });
}

export async function emailAssociationRecipient(db: Db, actorUserId: string, invitationId: string, access?: HouseholdAccess) {
  z.string().min(1).max(128).parse(invitationId);
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
    const [association] = await tx.select({ email: householdInvitations.email }).from(householdInvitations)
      .where(and(
        eq(householdInvitations.id, invitationId), eq(householdInvitations.householdId, actor.householdId),
        isNull(householdInvitations.tokenHash), pending(), gt(householdInvitations.expiresAt, sql`now()`),
      ));
    if (!association) throw new HouseholdAccessError("This household association is no longer available.");
    return association.email;
  });
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
    if (invitation.householdId === null) throw new HouseholdAccessError("This invitation is invalid or no longer available.");
    const issuer = await tx.select({ householdId: householdMembers.householdId }).from(householdMembers).where(and(
      eq(householdMembers.userId, invitation.invitedByUserId), eq(householdMembers.householdId, invitation.householdId),
    ));
    if (!issuer.length) throw new HouseholdAccessError("This invitation is invalid or no longer available.");
    const issuerAccess = await resolveHouseholdAccess(tx, invitation.invitedByUserId, invitation.householdId);
    const owner = await requireOwner(tx, invitation.invitedByUserId, issuerAccess);
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

export async function revokeInvitation(db: Db, actorUserId: string, invitationId: string, access?: HouseholdAccess) {
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
    const [revoked] = await tx.update(householdInvitations).set({ revokedAt: new Date() })
      .where(and(eq(householdInvitations.id, invitationId), eq(householdInvitations.householdId, actor.householdId), pending()))
      .returning({ id: householdInvitations.id });
    if (!revoked) throw new HouseholdAccessError("This invitation is no longer available.");
  });
}

/** Existing profile links require owner approval, not a member-submitted arbitrary person id. */
export async function assignMemberProfile(db: Db, actorUserId: string, targetUserId: string, personId: number, access?: HouseholdAccess) {
  z.number().int().positive().parse(personId);
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    const actor = await requireOwner(tx, actorUserId, access);
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
