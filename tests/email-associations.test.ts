import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import * as s from "../lib/db/schema";
import {
  acceptEmailAssociation, addEmailAssociation, declineEmailAssociation, pendingEmailAssociations,
  revokeInvitation,
} from "../lib/auth/household";
import { selectSessionHousehold } from "../lib/auth/household-session";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
const ownerIdentity = { userId: "owner", householdId: "owner-household" };
const recipientIdentity = { userId: "recipient", sessionId: "recipient-session" };

beforeAll(async () => { h = await openDb(); });
afterEach(async () => {
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

async function createHousehold(id: string, userId: string, email: string) {
  await h.db.insert(s.authUsers).values({ id: userId, name: userId, email, emailVerified: true });
  await h.db.insert(s.households).values({ id, name: `Household ${id}` });
  await h.db.insert(s.householdMembers).values({ householdId: id, userId, role: "owner" });
}

async function createRecipientWithExistingHousehold() {
  await h.db.insert(s.authUsers).values({ id: "recipient", name: "Recipient", email: "recipient@example.test", emailVerified: true });
  await h.db.insert(s.households).values({ id: "existing-household", name: "Private existing household" });
  await h.db.insert(s.householdMembers).values({ householdId: "existing-household", userId: "recipient", role: "owner" });
  await h.db.insert(s.authSessions).values({
    id: recipientIdentity.sessionId, userId: recipientIdentity.userId, token: "recipient-session-token",
    activeHouseholdId: "existing-household", expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
  });
}

it("supports the same normalized email in separate households without exposing household details", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createHousehold("second-owner-household", "second-owner", "second-owner@example.test");
  await createRecipientWithExistingHousehold();

  const first = await addEmailAssociation(h.db, "owner", {
    email: "  RECIPIENT@example.test ", displayName: "Pat", relationship: "partner",
  });
  const second = await addEmailAssociation(h.db, "second-owner", { email: "recipient@example.test" });
  expect(first.email).toBe("recipient@example.test");
  expect(second.email).toBe(first.email);
  await expect(addEmailAssociation(h.db, "owner", { email: "recipient@example.test" }))
    .rejects.toThrow("already has a pending association");

  const pending = await pendingEmailAssociations(h.db, recipientIdentity);
  expect(pending.map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(JSON.stringify(pending)).not.toContain("Private existing household");
  expect(JSON.stringify(pending)).not.toContain("Household owner-household");

  const existingMembership = await h.db.select().from(s.householdMembers)
    .where(eq(s.householdMembers.householdId, "existing-household"));
  const sessionBefore = await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, recipientIdentity.sessionId));
  await acceptEmailAssociation(h.db, recipientIdentity, first.id);
  const sessionAfter = await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, recipientIdentity.sessionId));
  expect(sessionAfter[0]).toMatchObject({
    activeHouseholdId: "existing-household", householdSelectionVersion: sessionBefore[0]!.householdSelectionVersion,
  });
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, "existing-household")))
    .toEqual(existingMembership);
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "recipient")))
    .toMatchObject([
      { householdId: "existing-household", role: "owner" },
      { householdId: ownerIdentity.householdId, role: "member", personId: null },
    ]);

  await selectSessionHousehold(h.db, recipientIdentity, ownerIdentity.householdId);
  expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, recipientIdentity.sessionId)))
    .toMatchObject([{ activeHouseholdId: ownerIdentity.householdId }]);
  await h.db.insert(s.householdInvitations).values({
    id: "duplicate-membership", householdId: ownerIdentity.householdId,
    email: "recipient@example.test", tokenHash: null, invitedByUserId: ownerIdentity.userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(acceptEmailAssociation(h.db, recipientIdentity, "duplicate-membership"))
    .rejects.toThrow("no longer available");
});

it("selects a first accepted household, while decline and revocation grant no membership", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createRecipientWithExistingHousehold();
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "recipient"));
  await h.db.update(s.authSessions).set({ activeHouseholdId: null }).where(eq(s.authSessions.id, recipientIdentity.sessionId));

  const first = await addEmailAssociation(h.db, "owner", { email: "recipient@example.test" });
  await acceptEmailAssociation(h.db, recipientIdentity, first.id);
  expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, recipientIdentity.sessionId)))
    .toMatchObject([{ activeHouseholdId: ownerIdentity.householdId, householdSelectionVersion: 1 }]);

  const declined = await addEmailAssociation(h.db, "owner", { email: "other@example.test" });
  await h.db.insert(s.authUsers).values({ id: "other", name: "Other", email: "other@example.test", emailVerified: true });
  await h.db.insert(s.authSessions).values({
    id: "other-session", userId: "other", token: "other-session-token",
    expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
  });
  const otherIdentity = { userId: "other", sessionId: "other-session" };
  await declineEmailAssociation(h.db, otherIdentity, declined.id);
  await expect(pendingEmailAssociations(h.db, otherIdentity)).resolves.toEqual([]);

  const revoked = await addEmailAssociation(h.db, "owner", { email: "third@example.test" });
  await revokeInvitation(h.db, "owner", revoked.id);
  await h.db.insert(s.authUsers).values({ id: "third", name: "Third", email: "third@example.test", emailVerified: true });
  await h.db.insert(s.authSessions).values({
    id: "third-session", userId: "third", token: "third-session-token",
    expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
  });
  await expect(acceptEmailAssociation(h.db, { userId: "third", sessionId: "third-session" }, revoked.id))
    .rejects.toThrow("no longer available");
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "third"))).toEqual([]);
});

it("requires the verified recipient's live session and refuses legacy quarantined memberships", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createRecipientWithExistingHousehold();
  const association = await addEmailAssociation(h.db, "owner", { email: "recipient@example.test" });
  await expect(acceptEmailAssociation(h.db, { userId: "wrong", sessionId: "recipient-session" }, association.id))
    .rejects.toThrow("Verify your email");
  await expect(acceptEmailAssociation(h.db, { userId: "recipient", sessionId: "missing-session" }, association.id))
    .rejects.toThrow("session has expired");
  await h.db.insert(s.householdMembers).values({ userId: "recipient", householdId: null, role: "member" });
  await expect(acceptEmailAssociation(h.db, recipientIdentity, association.id))
    .rejects.toThrow("operator migration");
  expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, association.id)))
    .toMatchObject([{ acceptedAt: null, declinedAt: null, revokedAt: null }]);
});

it("refuses existing members, expired recipient sessions and replayed declines", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createRecipientWithExistingHousehold();
  await expect(addEmailAssociation(h.db, "owner", { email: "owner@example.test" }))
    .rejects.toThrow("already in this household");
  const association = await addEmailAssociation(h.db, "owner", { email: "recipient@example.test" });
  const expired = { ...recipientIdentity, sessionId: "missing-session" };
  await expect(pendingEmailAssociations(h.db, expired)).rejects.toThrow("session has expired");
  await expect(declineEmailAssociation(h.db, expired, association.id)).rejects.toThrow("session has expired");
  await declineEmailAssociation(h.db, recipientIdentity, association.id);
  await expect(declineEmailAssociation(h.db, recipientIdentity, association.id)).rejects.toThrow("no longer available");
});

it("refuses a stale inviting owner and rolls back acceptance with an invalid selection", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createRecipientWithExistingHousehold();
  const association = await addEmailAssociation(h.db, "owner", { email: "recipient@example.test" });
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "owner"));
  await expect(acceptEmailAssociation(h.db, recipientIdentity, association.id)).rejects.toThrow("no longer available");
  await h.db.update(s.householdMembers).set({ role: "owner" }).where(eq(s.householdMembers.userId, "owner"));
  await h.db.update(s.authSessions).set({ activeHouseholdId: ownerIdentity.householdId })
    .where(eq(s.authSessions.id, recipientIdentity.sessionId));
  await expect(acceptEmailAssociation(h.db, recipientIdentity, association.id)).rejects.toThrow("Choose an available household");
  expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "recipient")))
    .toMatchObject([{ householdId: "existing-household" }]);
  expect(await h.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, association.id)))
    .toMatchObject([{ acceptedAt: null, acceptedByUserId: null }]);
});

it("preserves an explicit choice requirement when multiple existing households are unselected", async () => {
  await createHousehold(ownerIdentity.householdId, ownerIdentity.userId, "owner@example.test");
  await createRecipientWithExistingHousehold();
  await h.db.insert(s.households).values({ id: "another-existing", name: "Another existing household" });
  await h.db.insert(s.householdMembers).values({ householdId: "another-existing", userId: "recipient", role: "member" });
  await h.db.update(s.authSessions).set({ activeHouseholdId: null })
    .where(eq(s.authSessions.id, recipientIdentity.sessionId));
  const association = await addEmailAssociation(h.db, "owner", { email: "recipient@example.test" });
  await acceptEmailAssociation(h.db, recipientIdentity, association.id);
  expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, recipientIdentity.sessionId)))
    .toMatchObject([{ activeHouseholdId: null, householdSelectionVersion: 0 }]);
});
