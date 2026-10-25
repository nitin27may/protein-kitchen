import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { authSessions, authUsers, householdMembers, households } from "../db/schema";
import { withTx, type Tx } from "../db/tx";
import { claimHouseholdByOwnerEmail, HouseholdAccessError, pendingEmailAssociations } from "./household";
import { resolveHouseholdAccess, resolveOnlyHouseholdAccess } from "./household-access";

/** Both ids must come from the authenticated provider session, never request fields. */
export interface SessionIdentity {
  userId: string;
  sessionId: string;
}

async function checkedSession(tx: Tx, identity: SessionIdentity, lock: "share" | "update", userLock: "share" | "update" = "share") {
  const [user] = await tx.select({ id: authUsers.id }).from(authUsers)
    .where(and(eq(authUsers.id, identity.userId), eq(authUsers.emailVerified, true))).for(userLock);
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

/** Admission primitive only: quarantined legacy data is never adopted by a new household. */
export async function createSessionHousehold(db: Db, identity: SessionIdentity, name: string) {
  const householdName = z.string().trim().min(1, "Enter a household name.").max(100, "Use at most 100 characters.").parse(name);
  return withTx(db, async (tx) => {
    const session = await checkedSession(tx, identity, "update", "update");
    const [existing] = await tx.select({ userId: householdMembers.userId }).from(householdMembers)
      .where(eq(householdMembers.userId, identity.userId)).limit(1);
    if (existing) throw new HouseholdAccessError("Your account already has a household membership. Choose an available household to continue.");
    const householdId = randomUUID();
    await tx.insert(households).values({ id: householdId, name: householdName });
    await tx.insert(householdMembers).values({ householdId, userId: identity.userId, role: "owner" });
    await tx.update(authSessions).set({
      activeHouseholdId: householdId,
      householdSelectionVersion: sql`${authSessions.householdSelectionVersion} + 1`,
      updatedAt: new Date(),
    }).where(eq(authSessions.id, session.id));
    return { householdId, profileComplete: false as const };
  });
}

/** "<name or email local-part>'s kitchen", capped to the household name limit. */
export function defaultKitchenName(name: string | null | undefined, email: string) {
  const who = name?.trim() || email.trim().split("@")[0]?.trim() || "My";
  return `${who.slice(0, 90)}'s kitchen`;
}

export type Admission =
  | { status: "selected"; householdId: string; profileComplete: boolean }
  | { status: "choose" }
  | { status: "association"; associations: { id: string; expiresAt: Date }[] };

/**
 * Settles a verified session's household: select an existing membership, hold for a pending email association
 * (the person decides; "Start my own kitchen instead" calls createSessionHousehold), bind the configured owner
 * email to the imported household, or create a household automatically. Safe to run concurrently: losing a
 * creation race re-reads the winner's membership.
 */
export async function ensureAdmission(db: Db, identity: SessionIdentity, options: { ownerEmail?: string } = {}): Promise<Admission> {
  const existing = await selectExisting(db, identity);
  if (existing) return existing;
  const associations = await pendingEmailAssociations(db, identity);
  if (associations.length) return { status: "association", associations };
  const claimed = await claimHouseholdByOwnerEmail(db, identity.userId, options.ownerEmail);
  if (claimed?.householdId) {
    const selected = await selectSessionHousehold(db, identity, claimed.householdId);
    return { status: "selected", ...selected };
  }
  const [user] = await db.select({ name: authUsers.name, email: authUsers.email }).from(authUsers)
    .where(eq(authUsers.id, identity.userId)).limit(1);
  if (!user) throw new HouseholdAccessError("This household is not available to your verified account.");
  try {
    const created = await createSessionHousehold(db, identity, defaultKitchenName(user.name, user.email));
    return { status: "selected", householdId: created.householdId, profileComplete: false };
  } catch (error) {
    if (!(error instanceof HouseholdAccessError)) throw error;
    const winner = await selectExisting(db, identity);
    if (winner) return winner;
    throw error;
  }
}

async function selectExisting(db: Db, identity: SessionIdentity): Promise<Admission | null> {
  const current = await sessionHouseholds(db, identity);
  if (!current.households.length) return null;
  const chosen = current.selectedHouseholdId ?? (current.households.length === 1 ? current.households[0]!.id : null);
  if (!chosen || current.selectionUnavailable) return { status: "choose" };
  const selected = await selectSessionHousehold(db, identity, chosen);
  return { status: "selected", ...selected };
}
