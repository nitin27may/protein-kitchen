import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTx, type Tx } from "../db/tx";
import { authUsers, householdBootstrap, householdInvitations, householdMembers, people } from "../db/schema";
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

async function requireOwner(tx: Tx, userId: string) {
  await verifiedUser(tx, userId);
  const [member] = await tx.select().from(householdMembers).where(eq(householdMembers.userId, userId)).for("update");
  if (member?.role !== "owner") throw new HouseholdAccessError("Only a household owner can manage invitations and profile links.");
}

async function availableProfile(tx: Tx, personId: number) {
  const [person] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).for("update");
  if (!person) throw new HouseholdAccessError("The selected profile no longer exists.");
  const [member] = await tx.select().from(householdMembers).where(eq(householdMembers.personId, personId));
  if (member) throw new HouseholdAccessError("That profile is already linked to a household account.");
}

export async function createMemberProfile(db: Db, userId: string, input: PersonInputData) {
  const v = PersonInput.parse(input);
  if (v.id !== undefined) throw new HouseholdAccessError("Onboarding cannot overwrite an existing profile.");
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    await verifiedUser(tx, userId);
    const [member] = await tx.select().from(householdMembers).where(eq(householdMembers.userId, userId)).for("update");
    if (!member) throw new HouseholdAccessError("Join the household before creating your profile.");
    if (member.personId !== null) throw new HouseholdAccessError("Your account already has a profile.");
    const [person] = await tx.insert(people).values(personRow(v)).returning({ id: people.id });
    await tx.update(householdMembers).set({ personId: person!.id, updatedAt: new Date() })
      .where(eq(householdMembers.userId, userId));
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
    await tx.insert(householdBootstrap).values({ id: 1, ownerUserId: userId });
    const [member] = await tx.insert(householdMembers).values({ userId, role: "owner" }).returning();
    return member!;
  });
}

export async function issueInvitation(db: Db, actorUserId: string, input: { email: string; personId?: number }) {
  const email = emailSchema.parse(input.email);
  if (input.personId !== undefined) z.number().int().positive().parse(input.personId);
  const token = randomBytes(32).toString("base64url");
  const invitation = await withTx(db, async (tx) => {
    await lockHousehold(tx);
    await requireOwner(tx, actorUserId);
    const [existing] = await tx.select({ id: householdMembers.userId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(sql`lower(trim(${authUsers.email})) = ${email}`);
    if (existing) throw new HouseholdAccessError("That account is already in the household.");
    const now = new Date();
    await tx.update(householdInvitations).set({ revokedAt: now }).where(and(
      pending(), lte(householdInvitations.expiresAt, now),
    ));
    // A resend replaces the old email-bound token in the same transaction.
    await tx.update(householdInvitations).set({ revokedAt: now }).where(and(pending(), eq(householdInvitations.email, email)));
    if (input.personId !== undefined) {
      await availableProfile(tx, input.personId);
      const [reserved] = await tx.select().from(householdInvitations)
        .where(and(pending(), eq(householdInvitations.personId, input.personId)));
      if (reserved) throw new HouseholdAccessError("That profile is reserved by another invitation.");
    }
    const [row] = await tx.insert(householdInvitations).values({
      id: randomUUID(), email, tokenHash: tokenHash(token), invitedByUserId: actorUserId,
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
    await requireOwner(tx, invitation.invitedByUserId);
    const [existing] = await tx.select().from(householdMembers).where(eq(householdMembers.userId, userId));
    if (existing) throw new HouseholdAccessError("Your account is already in the household.");
    if (invitation.personId !== null) await availableProfile(tx, invitation.personId);
    const now = new Date();
    const [member] = await tx.insert(householdMembers).values({
      userId, role: "member", personId: invitation.personId, createdAt: now, updatedAt: now,
    }).returning();
    await tx.update(householdInvitations).set({ acceptedAt: now, acceptedByUserId: userId })
      .where(eq(householdInvitations.id, invitation.id));
    return member!;
  });
}

export async function revokeInvitation(db: Db, actorUserId: string, invitationId: string) {
  await withTx(db, async (tx) => {
    await lockHousehold(tx);
    await requireOwner(tx, actorUserId);
    const [revoked] = await tx.update(householdInvitations).set({ revokedAt: new Date() })
      .where(and(eq(householdInvitations.id, invitationId), pending()))
      .returning({ id: householdInvitations.id });
    if (!revoked) throw new HouseholdAccessError("This invitation is no longer available.");
  });
}

/** Existing profile links require owner approval, not a member-submitted arbitrary person id. */
export async function assignMemberProfile(db: Db, actorUserId: string, targetUserId: string, personId: number) {
  z.number().int().positive().parse(personId);
  return withTx(db, async (tx) => {
    await lockHousehold(tx);
    await requireOwner(tx, actorUserId);
    const [member] = await tx.select().from(householdMembers).where(eq(householdMembers.userId, targetUserId)).for("update");
    if (!member) throw new HouseholdAccessError("The selected account is not in the household.");
    if (member.personId === personId) return member;
    await availableProfile(tx, personId);
    const [reserved] = await tx.select().from(householdInvitations).where(and(
      pending(), eq(householdInvitations.personId, personId), sql`${householdInvitations.expiresAt} > now()`,
    ));
    if (reserved) throw new HouseholdAccessError("That profile is reserved by an invitation.");
    const [updated] = await tx.update(householdMembers).set({ personId, updatedAt: new Date() })
      .where(eq(householdMembers.userId, targetUserId)).returning();
    return updated!;
  });
}
