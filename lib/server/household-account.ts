import { and, eq, gt, isNull } from "drizzle-orm";
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
  const invitations = owner ? await db.select({ id: s.householdInvitations.id, email: s.householdInvitations.email })
    .from(s.householdInvitations).where(and(
      eq(s.householdInvitations.householdId, access.householdId),
      isNull(s.householdInvitations.acceptedAt), isNull(s.householdInvitations.revokedAt), gt(s.householdInvitations.expiresAt, new Date()),
    )) : [];
  const members = owner ? await db.select({
    userId: s.householdMembers.userId, role: s.householdMembers.role,
    name: s.authUsers.name, email: s.authUsers.email, profileName: s.people.name,
  }).from(s.householdMembers).innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId))
    .leftJoin(s.people, and(eq(s.people.id, s.householdMembers.personId), eq(s.people.householdId, access.householdId)))
    .where(eq(s.householdMembers.householdId, access.householdId)).orderBy(s.authUsers.name) : [];
  return { profile, owner, profiles, invitations, members };
}
