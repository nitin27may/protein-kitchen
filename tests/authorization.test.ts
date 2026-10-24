import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "../lib/auth/server";
import { getDb } from "../lib/server/context";
import { AuthConfigurationError } from "../lib/auth/config";
import { AccessDenied, actionDenial, checkPermission, requireMember, requirePageMember, routeAccess } from "../lib/auth/access";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }) }));
vi.mock("../lib/auth/server", () => ({ getAuth: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
let h: DbHandle;
const session = vi.fn();
const origin = "https://kitchen.example.test";
beforeAll(async () => { h = await openDb(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(redirect).mockImplementation((path) => { throw new Error(`redirect:${path}`); });
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "synthetic" }));
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getAuth).mockResolvedValue({ handler: vi.fn(), api: { getSession: session } });
  session.mockResolvedValue({ user: { id: "cook", emailVerified: true } });
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-authorization-secret-32-characters");
  await h.db.insert(s.authUsers).values({ id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true });
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });
async function admit(role: "owner" | "member" = "member") {
  await h.db.insert(s.households).values({ id: "a", name: "First synthetic household" });
  const [p] = await h.db.insert(s.people).values({
    householdId: "a",
    name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "cook", role, personId: p!.id });
  return p!.id;
}

describe("authoritative household membership", () => {
  it.each([false, true])("refuses ambiguous memberships even when the second profile is incomplete: %s", async (complete) => {
    await admit("owner");
    await h.db.insert(s.households).values({ id: "b", name: "Second synthetic household" });
    const [profile] = complete ? await h.db.insert(s.people).values({
      householdId: "b", name: "Second profile", sex: "other", birthDate: "2000-01-01", heightCm: 170,
      weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id }) : [];
    await h.db.insert(s.householdMembers).values({ householdId: "b", userId: "cook", role: "member", personId: profile?.id });
    await expect(requireMember()).rejects.toThrow("Select a household");
    expect(await actionDenial()).toEqual({ ok: false, error: "Select a household before continuing." });
    expect((await routeAccess(new Request(`${origin}/api/account/export`))).response?.status).toBe(403);
    await expect(requirePageMember()).rejects.toThrow("redirect:/onboarding");
  });
  it("refuses unowned membership even with a profile and owned membership without a profile", async () => {
    const personId = await admit();
    await h.db.update(s.householdMembers).set({ householdId: null }).where(eq(s.householdMembers.userId, "cook"));
    await expect(requireMember()).rejects.toThrow("Finish household");
    await h.db.update(s.householdMembers).set({ householdId: "a", personId: null }).where(eq(s.householdMembers.userId, "cook"));
    await expect(requireMember()).rejects.toThrow("Finish household");
    expect(await h.db.select().from(s.people).where(eq(s.people.id, personId))).toHaveLength(1);
  });
  it("requires a session before touching household data", async () => {
    session.mockResolvedValue(null);
    await expect(requireMember()).rejects.toMatchObject({ status: 401 });
    expect(getDb).not.toHaveBeenCalled();
  });
  it("rejects unverified, unaffiliated and incomplete accounts", async () => {
    session.mockResolvedValueOnce({ user: { id: "cook", emailVerified: false } });
    await expect(requireMember()).rejects.toThrow("Verify your email");
    await expect(requireMember()).rejects.toThrow("Finish household");
    await h.db.insert(s.householdMembers).values({ userId: "cook", role: "member" });
    await expect(requireMember()).rejects.toThrow("Finish household");
  });
  it("rechecks verification, profile links, roles and revoked memberships on every request", async () => {
    const personId = await admit("owner");
    expect(await requireMember(new Headers({ cookie: "explicit" }))).toEqual({ userId: "cook", role: "owner", personId });
    expect(session).toHaveBeenCalledWith({ headers: new Headers({ cookie: "explicit" }) });
    await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "cook"));
    expect(await actionDenial("owner")).toMatchObject({ ok: false, error: "Only a household owner can do that." });
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "cook"));
    await expect(requireMember()).rejects.toThrow("Finish household");
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "cook"));
    await h.db.delete(s.householdMembers);
    await expect(requireMember()).rejects.toThrow("Finish household");
  });
  it("limits private profile mutations to the linked member or an owner", async () => {
    const personId = await admit();
    expect(await actionDenial()).toBeNull();
    expect(await actionDenial({ personId })).toBeNull();
    expect(await actionDenial({ personId: personId + 1 })).toMatchObject({ ok: false, error: expect.stringContaining("only change your own") });
    checkPermission({ userId: "cook", role: "owner", personId }, { personId: personId + 1 });
    expect(() => checkPermission({ userId: "cook", role: "member", personId }, { personId: NaN })).toThrow(AccessDenied);
  });
  it("surfaces configuration failures without swallowing unrelated errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAuth).mockRejectedValueOnce(new AuthConfigurationError("synthetic key"));
    expect(await actionDenial()).toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
    expect(log).toHaveBeenCalled();
    session.mockRejectedValueOnce(new Error("synthetic database failure"));
    await expect(actionDenial()).rejects.toThrow("synthetic database failure");
  });
});

describe("page and route boundaries", () => {
  it("redirects anonymous and incomplete pages to their correct entry points", async () => {
    session.mockResolvedValueOnce(null);
    await expect(requirePageMember()).rejects.toThrow("redirect:/sign-in");
    await expect(requirePageMember()).rejects.toThrow("redirect:/onboarding");
    await admit();
    await expect(requirePageMember("owner")).rejects.toThrow("redirect:/account");
    expect(await requirePageMember()).toMatchObject({ role: "member" });
  });
  it("handles missing config explicitly but never masks unexpected page failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAuth).mockRejectedValueOnce(new AuthConfigurationError("synthetic config"));
    await expect(requirePageMember()).rejects.toThrow("redirect:/sign-in");
    session.mockRejectedValueOnce(new Error("synthetic bug"));
    await expect(requirePageMember()).rejects.toThrow("synthetic bug");
    await admit();
    await expect(Reflect.apply(requirePageMember, undefined, [null])).rejects.toBeInstanceOf(TypeError);
  });
  it("checks route cookies and rejects missing/foreign mutation origins", async () => {
    const personId = await admit();
    const request = new Request(`${origin}/api/push/subscribe`, { headers: { origin, cookie: "route-cookie" } });
    expect(await routeAccess(request, true)).toEqual({ member: { userId: "cook", role: "member", personId } });
    expect(session).toHaveBeenCalledWith({ headers: request.headers });
    vi.stubEnv("BETTER_AUTH_URL", `${origin}/`);
    expect((await routeAccess(request, true)).member?.personId).toBe(personId);
    for (const headers of [new Headers(), new Headers({ origin: "https://outside.example" })]) {
      const denied = await routeAccess(new Request(`${origin}/api/push/subscribe`, { headers }), true);
      expect(denied.response?.status).toBe(403);
      expect(denied.response?.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  it("returns uncached 401, 403 or 503 errors and rethrows programming failures", async () => {
    const req = new Request(`${origin}/api/plan/1/export`);
    session.mockResolvedValueOnce(null);
    expect((await routeAccess(req)).response?.status).toBe(401);
    expect((await routeAccess(req)).response?.status).toBe(403);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAuth).mockRejectedValueOnce(new AuthConfigurationError("synthetic config"));
    expect((await routeAccess(req)).response?.status).toBe(503);
    session.mockRejectedValueOnce(new Error("synthetic bug"));
    await expect(routeAccess(req)).rejects.toThrow("synthetic bug");
  });
});
