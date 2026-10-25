import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireMember, verifiedSessionIdentity, verifiedSessionUser } from "../lib/auth/access";
import { AuthConfigurationError } from "../lib/auth/config";
import { claimHousehold, HouseholdAccessError } from "../lib/auth/household";
import { getDb } from "../lib/server/context";
import * as s from "../lib/db/schema";
import {
  acceptHouseholdEmailAssociation, addHouseholdEmailAssociation, cancelInvitation, changeCookRole,
  chooseHousehold, declineHouseholdEmailAssociation, finishProfile, inviteCook, joinHousehold,
  linkOwnProfile, removeCook, resendHouseholdAssociationNotice,
} from "../app/onboarding/actions";
import { resolveSessionHouseholdAccess } from "../lib/auth/household-session";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/server", () => ({ sendHouseholdAssociationNotice: vi.fn() }));
vi.mock("../lib/auth/access", async (original) => ({
  ...await original<typeof import("../lib/auth/access")>(), verifiedSessionUser: vi.fn(), verifiedSessionIdentity: vi.fn(), requireMember: vi.fn(),
}));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
import { sendHouseholdAssociationNotice } from "../lib/auth/server";
let h: DbHandle;
const secret = "synthetic-onboarding-bootstrap-key-only";
const input = {
  name: "Synthetic cook", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
  activityLevel: "light" as const, proteinMode: "fixed" as const, proteinValue: 95, kcalTarget: null, reminderTime: null,
};
beforeAll(async () => { h = await openDb(); });
beforeEach(async () => {
  await h.db.insert(s.households).values({ id: "fixture", name: "Synthetic household" });
  vi.resetAllMocks();
  vi.stubEnv("HOUSEHOLD_BOOTSTRAP_SECRET", secret);
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: 1 });
  vi.mocked(verifiedSessionUser).mockResolvedValue({
    id: "owner", email: "owner@example.test", name: "Synthetic owner", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  vi.mocked(verifiedSessionIdentity).mockImplementation(async () => {
    const user = await verifiedSessionUser();
    return { userId: user.id, sessionId: `${user.id}-session` };
  });
  await h.db.insert(s.authUsers).values([
    { id: "owner", name: "Synthetic owner", email: "owner@example.test", emailVerified: true },
    { id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true },
  ]);
  await h.db.insert(s.authSessions).values(["owner", "cook"].map((id) => ({
    id: `${id}-session`, userId: id, token: `synthetic-${id}`, expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
  })));
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

it("binds owner bootstrap, profile creation and invitations to the server session", async () => {
  expect(await joinHousehold("bootstrap", secret)).toEqual({ ok: true });
  const profile = await finishProfile(input);
  expect(profile).toMatchObject({ ok: true, id: expect.any(Number) });
  const invite = await inviteCook("cook@example.test");
  expect(invite).toMatchObject({ ok: true, token: expect.any(String), email: "cook@example.test" });
  expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", role: "owner" }]);
});
it("uses only the verified invitee's identity and an owner-reserved existing profile", async () => {
  await claimHousehold(h.db, "owner", secret, secret);
  const [person] = await h.db.insert(s.people).values({
    householdId: "fixture",
    name: "Synthetic existing", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  const invite = await inviteCook("cook@example.test", person!.id);
  if (!invite.ok) throw new Error(invite.error);
  const user = await verifiedSessionUser();
  vi.mocked(verifiedSessionUser).mockResolvedValue({ ...user, id: "cook" });
  expect(await joinHousehold("invitation", invite.token)).toEqual({ ok: true });
  expect(await finishProfile(input)).toMatchObject({ ok: false, error: expect.stringContaining("already has a profile") });
  expect(await linkOwnProfile(person!.id)).toMatchObject({ ok: false, error: expect.stringContaining("Only a household owner") });
  expect(await inviteCook("outsider@example.test")).toMatchObject({ ok: false });
  expect(await h.db.select().from(s.people)).toHaveLength(1);
  expect(await h.db.select().from(s.householdMembers)).toHaveLength(2);
});
it("allows an owner to link their existing profile and revoke an invitation", async () => {
  await joinHousehold("bootstrap", secret);
  const [person] = await h.db.insert(s.people).values({
    householdId: "fixture",
    name: "Synthetic existing", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  expect(await linkOwnProfile(person!.id)).toEqual({ ok: true });
  await inviteCook("cook@example.test");
  const [row] = await h.db.select().from(s.householdInvitations);
  expect(await cancelInvitation(row!.id)).toEqual({ ok: true });
  expect(await cancelInvitation(row!.id)).toMatchObject({ ok: false });
});
it("adds email associations without returning a grant and surfaces notification failures for retry", async () => {
  await joinHousehold("bootstrap", secret);
  vi.mocked(sendHouseholdAssociationNotice).mockResolvedValue(undefined);
  expect(await addHouseholdEmailAssociation({ email: "invalid" })).toMatchObject({ ok: false });
  expect(await resendHouseholdAssociationNotice("missing")).toMatchObject({ ok: false });
  const result = await addHouseholdEmailAssociation({
    email: "  NEXT@example.test ", displayName: "Pat", relationship: "partner",
  });
  expect(result).toMatchObject({ ok: true, emailSent: true });
  expect("token" in result).toBe(false);
  expect(sendHouseholdAssociationNotice).toHaveBeenCalledWith("next@example.test");
  const [association] = await h.db.select().from(s.householdInvitations);
  expect(association).toMatchObject({
    email: "next@example.test", tokenHash: null, displayName: "Pat", relationship: "partner",
    acceptedAt: null, declinedAt: null, revokedAt: null,
  });

  vi.mocked(sendHouseholdAssociationNotice).mockRejectedValueOnce(new Error("synthetic private mail failure"));
  const retryable = await addHouseholdEmailAssociation({ email: "another@example.test" });
  expect(retryable).toMatchObject({ ok: true, emailSent: false });
  const [retryAssociation] = await h.db.select().from(s.householdInvitations)
    .where(eq(s.householdInvitations.email, "another@example.test"));
  vi.mocked(sendHouseholdAssociationNotice).mockRejectedValueOnce(new Error("synthetic retry failure"));
  expect(await resendHouseholdAssociationNotice(retryAssociation!.id)).toEqual({
    ok: false, error: "The email could not be sent. Try again.",
  });
  expect(await resendHouseholdAssociationNotice(retryAssociation!.id)).toEqual({ ok: true });
  expect(sendHouseholdAssociationNotice).toHaveBeenCalledWith("another@example.test");
});
it("accepts and declines associations through the verified onboarding actions", async () => {
  await joinHousehold("bootstrap", secret);
  await h.db.insert(s.households).values({ id: "second", name: "Synthetic second household" });
  await h.db.insert(s.authUsers).values({
    id: "inviter", name: "Synthetic inviter", email: "inviter@example.test", emailVerified: true,
  });
  await h.db.insert(s.householdMembers).values({ householdId: "second", userId: "inviter", role: "owner" });
  await h.db.insert(s.householdInvitations).values([
    {
      id: "accept-association", householdId: "second", email: "owner@example.test",
      tokenHash: null, invitedByUserId: "inviter", expiresAt: new Date(Date.now() + 60_000),
    },
    {
      id: "decline-association", householdId: "second", email: "cook@example.test",
      tokenHash: null, invitedByUserId: "inviter", expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  expect(await acceptHouseholdEmailAssociation("accept-association")).toEqual({ ok: true });
  vi.mocked(verifiedSessionIdentity).mockResolvedValue({ userId: "cook", sessionId: "cook-session" });
  expect(await declineHouseholdEmailAssociation("decline-association")).toEqual({ ok: true });
});
it("refuses anonymous operations before database access", async () => {
  vi.mocked(verifiedSessionUser).mockRejectedValue(new HouseholdAccessError("Sign in before continuing."));
  vi.mocked(requireMember).mockRejectedValue(new HouseholdAccessError("Sign in before continuing."));
  for (const action of [
    () => joinHousehold("bootstrap", secret), () => finishProfile(input), () => inviteCook("cook@example.test"),
    () => linkOwnProfile(1), () => cancelInvitation("missing"), () => changeCookRole("cook", "owner"), () => removeCook("cook"), () => chooseHousehold("fixture"),
  ]) expect(await action()).toEqual({ ok: false, error: "Sign in before continuing." });
  expect(getDb).not.toHaveBeenCalled();
});
it("requires an owner session for role/removal management and preserves the final owner", async () => {
  await joinHousehold("bootstrap", secret);
  await finishProfile(input);
  await h.db.insert(s.householdMembers).values({ householdId: "fixture", userId: "cook", role: "member" });
  const user = await verifiedSessionUser();
  vi.mocked(verifiedSessionUser).mockResolvedValue({ ...user, id: "cook" });
  await finishProfile({ ...input, name: "Synthetic second cook" });
  expect(await changeCookRole("cook", "owner")).toEqual({ ok: true });
  expect(await changeCookRole("cook", "member")).toEqual({ ok: true });
  expect(await changeCookRole("owner", "member")).toMatchObject({ ok: false, error: expect.stringContaining("at least one verified owner") });
  vi.mocked(requireMember).mockResolvedValue({ userId: "cook", role: "member", personId: 2 });
  vi.mocked(getDb).mockClear();
  expect(await changeCookRole("cook", "owner")).toMatchObject({ ok: false, error: expect.stringContaining("Only a household owner") });
  expect(await removeCook("owner")).toMatchObject({ ok: false, error: expect.stringContaining("Only a household owner") });
  expect(getDb).not.toHaveBeenCalled();
  vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: 1 });
  expect(await removeCook("cook")).toEqual({ ok: true });
  expect(await removeCook("cook")).toMatchObject({ ok: false });
  expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
});
it("returns configuration and field errors explicitly, and rethrows unexpected failures", async () => {
  vi.mocked(verifiedSessionUser).mockRejectedValueOnce(new AuthConfigurationError("synthetic missing key"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await joinHousehold("bootstrap", secret)).toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
  expect(log).toHaveBeenCalledWith("Account access requires authentication configuration.");
  await joinHousehold("bootstrap", secret);
  expect(await finishProfile({ ...input, name: "", proteinValue: 0 })).toMatchObject({
    ok: false, fields: { name: "Enter a name", proteinValue: "Enter a protein target" },
  });
  expect(await joinHousehold("invitation", "")).toMatchObject({ ok: false });
  vi.stubEnv("HOUSEHOLD_BOOTSTRAP_SECRET", "");
  expect(await joinHousehold("bootstrap", secret)).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
  expect(await Reflect.apply(joinHousehold, null, ["owner", secret])).toMatchObject({ ok: false, error: expect.stringContaining("Choose how") });
  vi.mocked(verifiedSessionUser).mockRejectedValueOnce(new Error("synthetic unexpected failure"));
  await expect(finishProfile(input)).rejects.toThrow("synthetic unexpected failure");
});

  it("selects only a verified session membership, validates choices and preserves the other session", async () => {
    await joinHousehold("bootstrap", secret);
    const sessions = await h.db.select().from(s.authSessions);
    expect(await chooseHousehold("fixture")).toEqual({ ok: true, householdId: "fixture", profileComplete: false });
    expect(await chooseHousehold("foreign")).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    expect(await chooseHousehold("")).toMatchObject({ ok: false, fields: expect.any(Object) });
    expect(await chooseHousehold("x".repeat(129))).toMatchObject({ ok: false });
    expect(await h.db.select().from(s.authSessions).where(eq(s.authSessions.userId, "cook"))).toEqual(sessions.filter((session) => session.userId === "cook"));
    await h.db.update(s.authSessions).set({ expiresAt: new Date(0) }).where(eq(s.authSessions.id, "owner-session"));
    expect(await chooseHousehold("fixture")).toMatchObject({ ok: false, error: expect.stringContaining("session has expired") });
  });

  it("creates a profile in the selected household without moving the other linked profile", async () => {
    await joinHousehold("bootstrap", secret);
    const original = await finishProfile(input);
    expect(original.ok).toBe(true);
    await h.db.insert(s.households).values({ id: "second", name: "Second" });
    await h.db.insert(s.householdMembers).values({ userId: "owner", householdId: "second", role: "owner" });
    expect(await chooseHousehold("second")).toMatchObject({ ok: true, profileComplete: false });
    expect(await finishProfile({ ...input, name: "Second household profile" })).toMatchObject({ ok: true });
    expect(await h.db.select().from(s.people).orderBy(s.people.id)).toMatchObject([
      { householdId: "fixture", name: input.name }, { householdId: "second", name: "Second household profile" },
    ]);
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "owner"))).toHaveLength(2);
  });

  it("scopes actual invitation, profile-link, role and removal actions to the selected household", async () => {
    await joinHousehold("bootstrap", secret);
    await finishProfile(input);
    await h.db.insert(s.households).values({ id: "second", name: "Second" });
    await h.db.insert(s.householdMembers).values({ userId: "owner", householdId: "second", role: "owner" });
    expect(await chooseHousehold("second")).toMatchObject({ ok: true });
    const [person] = await h.db.insert(s.people).values({
      householdId: "second", name: "Existing selected profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    expect(await linkOwnProfile(person!.id)).toEqual({ ok: true });
    const invited = await inviteCook("next@example.test");
    expect(invited).toMatchObject({ ok: true });
    const [invitation] = await h.db.select().from(s.householdInvitations);
    expect(invitation!.householdId).toBe("second");
    expect(await cancelInvitation(invitation!.id)).toEqual({ ok: true });
    const [cook] = await h.db.insert(s.people).values({
      householdId: "second", name: "Selected cook", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await h.db.insert(s.householdMembers).values([
      { householdId: "second", userId: "cook", personId: cook!.id, role: "member" },
      { householdId: "fixture", userId: "cook", role: "member" },
    ]);
    const access = await resolveSessionHouseholdAccess(h.db, { userId: "owner", sessionId: "owner-session" });
    vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: person!.id, householdAccess: access });
    expect(await changeCookRole("cook", "owner")).toEqual({ ok: true });
    expect(await h.db.select().from(s.householdMembers).where(and(eq(s.householdMembers.householdId, "fixture"), eq(s.householdMembers.userId, "cook"))))
      .toMatchObject([{ role: "member" }]);
    expect(await removeCook("cook")).toEqual({ ok: true });
    expect(await h.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "cook")))
      .toMatchObject([{ householdId: "fixture", role: "member" }]);
  });
