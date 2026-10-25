import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { refreshHouseholdAccess, requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";

export async function householdAccount(db: Db, access: HouseholdAccess) {
  await refreshHouseholdAccess(db, access);
  const personId = requireHouseholdProfile(access);
  const [profile] = await db.select({ id: s.people.id, name: s.people.name }).from(s.people)
    .where(and(eq(s.people.id, personId), eq(s.people.householdId, access.householdId)));
  const owner = access.role === "owner";
  const profiles = owner ? await db.select({ id: s.people.id, name: s.people.name }).from(s.people)
    .where(eq(s.people.householdId, access.householdId)).orderBy(s.people.id) : [];
  const invitations = owner ? await db.select({
    id: s.householdInvitations.id, email: s.householdInvitations.email,
    displayName: s.householdInvitations.displayName, relationship: s.householdInvitations.relationship,
    tokenHash: s.householdInvitations.tokenHash,
  })
    .from(s.householdInvitations).where(and(
      eq(s.householdInvitations.householdId, access.householdId),
      isNull(s.householdInvitations.acceptedAt), isNull(s.householdInvitations.declinedAt),
      isNull(s.householdInvitations.revokedAt), gt(s.householdInvitations.expiresAt, new Date()),
    )).then((rows) => rows.map(({ tokenHash, ...row }) => ({ ...row, canResend: tokenHash === null }))) : [];
  const incomingAssociations = await db.select({ id: s.householdInvitations.id })
    .from(s.householdInvitations).innerJoin(s.authUsers, and(
      eq(s.authUsers.id, access.userId), eq(s.authUsers.emailVerified, true),
      sql`lower(trim(${s.householdInvitations.email})) = lower(trim(${s.authUsers.email}))`,
    )).where(and(
      isNull(s.householdInvitations.tokenHash), isNull(s.householdInvitations.acceptedAt),
      isNull(s.householdInvitations.declinedAt),
      isNull(s.householdInvitations.revokedAt), gt(s.householdInvitations.expiresAt, new Date()),
    ));
  const members = owner ? await db.select({
    userId: s.householdMembers.userId, role: s.householdMembers.role,
    name: s.authUsers.name, email: s.authUsers.email, profileName: s.people.name,
  }).from(s.householdMembers).innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId))
    .leftJoin(s.people, and(eq(s.people.id, s.householdMembers.personId), eq(s.people.householdId, access.householdId)))
    .where(eq(s.householdMembers.householdId, access.householdId)).orderBy(s.authUsers.name) : [];
  // Accounts created by email code have no account name; show the profile name, else the email local-part.
  const named = members.map((member) => ({ ...member, name: member.name.trim() || member.profileName || member.email.split("@")[0]! }));
  return { profile, owner, profiles, invitations, incomingAssociations, members: named };
}
