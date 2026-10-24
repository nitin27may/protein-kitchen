import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { authSessions, authUsers, householdMembers, households } from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { HouseholdAccessError } from "./household";
import { resolveHouseholdAccess, resolveOnlyHouseholdAccess } from "./household-access";

/** Both ids must come from the authenticated provider session, never request fields. */
export interface SessionIdentity {
  userId: string;
  sessionId: string;
}

async function checkedSession(tx: Tx, identity: SessionIdentity, lock: "share" | "update") {
  const [user] = await tx.select({ id: authUsers.id }).from(authUsers)
    .where(and(eq(authUsers.id, identity.userId), eq(authUsers.emailVerified, true))).for("share");
  if (!user) throw new HouseholdAccessError("This household is not available to your verified account.");
  const [session] = await tx.select().from(authSessions).where(and(
    eq(authSessions.id, identity.sessionId), eq(authSessions.userId, identity.userId), gt(authSessions.expiresAt, sql`now()`),
  )).for(lock);
  if (!session) throw new HouseholdAccessError("Your session has expired. Sign in again before continuing.");
  return session;
}

export async function sessionHouseholds(db: Db, identity: SessionIdentity) {
  return withTx(db, async (tx) => {
    const session = await checkedSession(tx, identity, "share");
    const memberships = await tx.select({
      id: households.id, name: households.name, role: householdMembers.role, personId: householdMembers.personId,
    }).from(householdMembers).innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(eq(householdMembers.userId, identity.userId)).orderBy(households.name, households.id);
    const selected = memberships.find((membership) => membership.id === session.activeHouseholdId);
    return {
      households: memberships,
      selectedHouseholdId: selected?.id ?? null,
      selectionUnavailable: session.activeHouseholdId !== null && selected === undefined,
    };
  });
}

export async function resolveSessionHouseholdAccess(db: Db, identity: SessionIdentity) {
  return withTx(db, async (tx) => {
    const session = await checkedSession(tx, identity, "share");
    const access = session.activeHouseholdId === null
      ? await resolveOnlyHouseholdAccess(tx, identity.userId)
      : await resolveHouseholdAccess(tx, identity.userId, session.activeHouseholdId);
    return Object.freeze({
      ...access,
      session: Object.freeze({
        id: session.id, householdId: session.activeHouseholdId, selectionVersion: session.householdSelectionVersion,
      }),
    });
  });
}

export async function selectSessionHousehold(db: Db, identity: SessionIdentity, householdId: string) {
  return withTx(db, async (tx) => {
    const session = await checkedSession(tx, identity, "update");
    const access = await resolveHouseholdAccess(tx, identity.userId, householdId);
    if (session.activeHouseholdId !== householdId) {
      await tx.update(authSessions).set({
        activeHouseholdId: householdId,
        householdSelectionVersion: sql`${authSessions.householdSelectionVersion} + 1`,
        updatedAt: new Date(),
      }).where(eq(authSessions.id, session.id));
    }
    return { householdId: access.householdId, profileComplete: access.personId !== null };
  });
}
