import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { authUsers, householdMembers, households, people } from "../db/schema";
import { HouseholdAccessError } from "./household";

const verifiedHousehold = Symbol("verified-household");

export interface HouseholdAccess {
  readonly [verifiedHousehold]: true;
  readonly householdId: string;
  readonly userId: string;
  readonly role: "owner" | "member";
  readonly personId: number | null;
}

/** userId must come from the authenticated server session, never a client-submitted account id. */
export async function resolveHouseholdAccess(db: Db, userId: string, householdId: string): Promise<HouseholdAccess> {
  const [row] = await db.select({
    householdId: householdMembers.householdId, userId: householdMembers.userId, role: householdMembers.role,
    personId: householdMembers.personId, profileHouseholdId: people.householdId,
  }).from(householdMembers)
    .innerJoin(authUsers, and(eq(authUsers.id, householdMembers.userId), eq(authUsers.emailVerified, true)))
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .leftJoin(people, eq(people.id, householdMembers.personId))
    .where(and(eq(householdMembers.userId, userId), eq(householdMembers.householdId, householdId))).limit(1)
    .for("share", { of: [householdMembers, authUsers] });
  if (!row || (row.personId !== null && row.profileHouseholdId !== row.householdId)) {
    throw new HouseholdAccessError("This household is not available to your verified account.");
  }
  return Object.freeze({
    [verifiedHousehold]: true as const, householdId, userId: row.userId, role: row.role, personId: row.personId,
  });
}

/** Revalidate inside mutations so an old resolved selection cannot survive revocation or a profile/role change. */
export async function refreshHouseholdAccess(db: Db, access: HouseholdAccess): Promise<HouseholdAccess> {
  if (access[verifiedHousehold] !== true) throw new HouseholdAccessError("Resolve household membership before continuing.");
  const current = await resolveHouseholdAccess(db, access.userId, access.householdId);
  if (current.role !== access.role || current.personId !== access.personId) {
    throw new HouseholdAccessError("Your household access changed. Reload before continuing.");
  }
  return current;
}

export function requireHouseholdProfile(access: HouseholdAccess) {
  if (access.personId === null) throw new HouseholdAccessError("Finish your household profile before continuing.");
  return access.personId;
}
