import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getTableName, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireMember, verifiedSessionUser } from "../lib/auth/access";
import { AuthConfigurationError } from "../lib/auth/config";
import { claimHousehold, HouseholdAccessError } from "../lib/auth/household";
import { getDb } from "../lib/server/context";
import * as s from "../lib/db/schema";
import { cancelInvitation, changeCookRole, finishProfile, inviteCook, joinHousehold, linkOwnProfile, removeCook } from "../app/onboarding/actions";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", async (original) => ({
  ...await original<typeof import("../lib/auth/access")>(), verifiedSessionUser: vi.fn(), requireMember: vi.fn(),
}));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
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
  await h.db.insert(s.authUsers).values([
    { id: "owner", name: "Synthetic owner", email: "owner@example.test", emailVerified: true },
    { id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true },
  ]);
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
it("refuses anonymous operations before database access", async () => {
  vi.mocked(verifiedSessionUser).mockRejectedValue(new HouseholdAccessError("Sign in before continuing."));
  vi.mocked(requireMember).mockRejectedValue(new HouseholdAccessError("Sign in before continuing."));
  for (const action of [
    () => joinHousehold("bootstrap", secret), () => finishProfile(input), () => inviteCook("cook@example.test"),
    () => linkOwnProfile(1), () => cancelInvitation("missing"), () => changeCookRole("cook", "owner"), () => removeCook("cook"),
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
