import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { createAuth, type AuthCodeMail } from "../lib/auth/create";
import * as s from "../lib/db/schema";
import { accountHasPassword, takePasswordAttempt } from "../lib/auth/password";
import { renameHousehold } from "../lib/auth/household";
import { actionDenial } from "../lib/auth/access";
import { getAuth } from "../lib/auth/server";
import { verifiedSessionIdentity } from "../lib/auth/access";
import { getDb } from "../lib/server/context";
import { changeAccountPassword, setAccountPassword } from "../app/account/actions";
import { renameHousehold as renameHouseholdAction } from "../app/households/actions";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("../lib/auth/server", () => ({ getAuth: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/auth/access", async (original) => ({
  ...await original<typeof import("../lib/auth/access")>(), actionDenial: vi.fn(), verifiedSessionIdentity: vi.fn(),
}));
import { headers as nextHeaders } from "next/headers";

let h: DbHandle;
let auth: ReturnType<typeof createAuth>;
let mailbox: AuthCodeMail[];
const origin = "http://localhost:3113";
const options = { baseURL: origin, secret: "synthetic-account-password-secret-32chars", isVercel: false, sendLink: async () => {} };
const password = "Synthetic-set-password-123!";
const replacement = "Synthetic-changed-password-456!";

beforeAll(async () => { h = await openDb(); });
beforeEach(() => {
  mailbox = [];
  auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
  vi.mocked(getAuth).mockImplementation(async () => auth);
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(actionDenial).mockResolvedValue(null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

function call(path: string, body?: object, extra: Record<string, string> = {}) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "198.51.100.9", ...extra },
    body: body ? JSON.stringify(body) : undefined,
  }));
}
const cookieOf = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function signUp(email: string) {
  expect((await call("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
  const otp = mailbox.findLast((mail) => mail.email === email && mail.type === "sign-in")!.otp;
  const response = await call("/sign-in/email-otp", { email, otp });
  expect(response.status, await response.clone().text()).toBe(200);
  return cookieOf(response);
}
const as = (cookie: string) => new Headers({ cookie });
async function userId(email: string) {
  const [user] = await h.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
  return user!.id;
}
const signInStatus = async (email: string, value: string) => (await call("/sign-in/email", { email, password: value })).status;

describe("setting and changing a password for an account created by email code", () => {
  it("starts with no password, then lets the owner of the session set one and sign in with it", async () => {
    const cookie = await signUp("cook@example.test");
    const id = await userId("cook@example.test");
    expect(await accountHasPassword(h.db, id)).toBe(false);
    expect(await signInStatus("cook@example.test", password)).toBe(401);
    expect(await auth.api.setPassword({ headers: as(cookie), newPassword: password })).toEqual({ ok: true });
    expect(await accountHasPassword(h.db, id)).toBe(true);
    expect(await signInStatus("cook@example.test", password)).toBe(200);
    expect(await signInStatus("cook@example.test", "Synthetic-wrong-password-1!")).toBe(401);
    expect((await h.db.select().from(s.authAccounts))[0]!.password).not.toContain(password);
  });
  it("refuses a second set, a wrong current password and a short password, and leaves the old password working", async () => {
    const cookie = await signUp("cook@example.test");
    await auth.api.setPassword({ headers: as(cookie), newPassword: password });
    expect(await auth.api.setPassword({ headers: as(cookie), newPassword: replacement })).toEqual({ ok: false, reason: "already-set" });
    expect(await auth.api.changePassword({ headers: as(cookie), currentPassword: "Synthetic-wrong-password-1!", newPassword: replacement }))
      .toEqual({ ok: false, reason: "wrong-current" });
    expect(await signInStatus("cook@example.test", password)).toBe(200);
    expect(await signInStatus("cook@example.test", replacement)).toBe(401);
  });
  it("changes the password, keeps this session and signs out the others", async () => {
    const first = await signUp("cook@example.test");
    await auth.api.setPassword({ headers: as(first), newPassword: password });
    const second = cookieOf(await call("/sign-in/email", { email: "cook@example.test", password }));
    expect(await auth.api.changePassword({ headers: as(first), currentPassword: password, newPassword: replacement })).toEqual({ ok: true });
    expect(await (await call("/get-session", undefined, { cookie: first })).json()).toMatchObject({ user: { email: "cook@example.test" } });
    expect(await (await call("/get-session", undefined, { cookie: second })).json()).toBeNull();
    expect(await signInStatus("cook@example.test", password)).toBe(401);
    expect(await signInStatus("cook@example.test", replacement)).toBe(200);
  });
  it("refuses change before a password exists and refuses an unauthenticated or unverified caller", async () => {
    const cookie = await signUp("cook@example.test");
    expect(await auth.api.changePassword({ headers: as(cookie), currentPassword: password, newPassword: replacement })).toEqual({ ok: false, reason: "no-password" });
    expect(await auth.api.setPassword({ headers: new Headers(), newPassword: password })).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await auth.api.setPassword({ headers: as("better-auth.session_token=forged"), newPassword: password })).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await h.db.select().from(s.authAccounts).where(eq(s.authAccounts.providerId, "credential"))).toEqual([]);
    // Only the one authenticated attempt above is counted; unauthenticated callers never create a limiter row.
    const keys = (await h.db.select().from(s.authRateLimits)).map((row) => row.key).filter((key) => key.startsWith("account-password:"));
    expect(keys).toEqual([`account-password:${await userId("cook@example.test")}`]);
  });
  it("is server-only: the provider exposes no HTTP route to set a password", async () => {
    const cookie = await signUp("cook@example.test");
    expect((await call("/set-password", { newPassword: password }, { cookie })).status).toBe(404);
    expect(await accountHasPassword(h.db, await userId("cook@example.test"))).toBe(false);
  });
  it("never lets one user's session touch another account", async () => {
    const a = await signUp("a@example.test");
    const b = await signUp("b@example.test");
    await auth.api.setPassword({ headers: as(a), newPassword: password });
    expect(await auth.api.setPassword({ headers: as(b), newPassword: replacement })).toEqual({ ok: true });
    expect(await signInStatus("a@example.test", password)).toBe(200);
    expect(await signInStatus("a@example.test", replacement)).toBe(401);
    expect(await signInStatus("b@example.test", replacement)).toBe(200);
    expect(await auth.api.changePassword({ headers: as(b), currentPassword: password, newPassword: "Synthetic-takeover-789!" }))
      .toEqual({ ok: false, reason: "wrong-current" });
    expect(await signInStatus("a@example.test", password)).toBe(200);
  });
  it("limits attempts per user at five a minute, across auth instances, and recovers after the window", async () => {
    const cookie = await signUp("cook@example.test");
    await auth.api.setPassword({ headers: as(cookie), newPassword: password });
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await auth.api.changePassword({ headers: as(cookie), currentPassword: "Synthetic-wrong-password-1!", newPassword: replacement }))
        .toEqual({ ok: false, reason: "wrong-current" });
    }
    auth = createAuth(h.db, { ...options, sendCode: async () => {} });
    expect(await auth.api.changePassword({ headers: as(cookie), currentPassword: password, newPassword: replacement })).toEqual({ ok: false, reason: "rate-limited" });
    expect(await signInStatus("cook@example.test", password)).toBe(200);
    const id = await userId("cook@example.test");
    expect(await takePasswordAttempt(h.db, id, Date.now() + 61_000)).toBe(true);
  });
});

describe("account password server actions", () => {
  beforeEach(() => { vi.mocked(nextHeaders).mockResolvedValue(new Headers()); });
  const spies = () => ({
    error: vi.spyOn(console, "error").mockImplementation(() => {}), warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  });

  it("deny before any validation, session read or write when actionDenial refuses", async () => {
    const denied = { ok: false as const, error: "Sign in before continuing." };
    vi.mocked(actionDenial).mockResolvedValue(denied);
    expect(await setAccountPassword({ newPassword: password })).toEqual(denied);
    expect(await changeAccountPassword({ currentPassword: password, newPassword: replacement })).toEqual(denied);
    expect(getAuth).not.toHaveBeenCalled();
    expect(await h.db.select().from(s.authRateLimits)).toEqual([]);
  });
  it("validates 12 to 128 characters and rejects extra keys before touching the provider", async () => {
    const cookie = await signUp("cook@example.test");
    vi.mocked(nextHeaders).mockResolvedValue(as(cookie));
    vi.mocked(getAuth).mockClear();
    expect(await setAccountPassword({ newPassword: "short-pass1" })).toMatchObject({ ok: false, fields: { newPassword: expect.stringContaining("at least 12") } });
    expect(await setAccountPassword({ newPassword: "x".repeat(129) })).toMatchObject({ ok: false, fields: { newPassword: expect.stringContaining("at most 128") } });
    expect(await setAccountPassword({ newPassword: password, userId: "someone-else" } as never)).toMatchObject({ ok: false });
    expect(await changeAccountPassword({ currentPassword: password, newPassword: password })).toMatchObject({ ok: false, fields: { newPassword: expect.any(String) } });
    expect(getAuth).not.toHaveBeenCalled();
    expect(await accountHasPassword(h.db, await userId("cook@example.test"))).toBe(false);
    expect(await setAccountPassword({ newPassword: "x".repeat(128) })).toEqual({ ok: true });
  });
  it("sets then changes the password for the session's own user and never logs a password", async () => {
    const log = spies();
    const cookie = await signUp("cook@example.test");
    vi.mocked(nextHeaders).mockResolvedValue(as(cookie));
    expect(await setAccountPassword({ newPassword: password })).toEqual({ ok: true });
    expect(await setAccountPassword({ newPassword: replacement })).toEqual({ ok: false, error: expect.stringContaining("already set") });
    expect(await changeAccountPassword({ currentPassword: "Synthetic-wrong-password-1!", newPassword: replacement }))
      .toEqual({ ok: false, error: "Your current password is not correct." });
    expect(await changeAccountPassword({ currentPassword: password, newPassword: replacement })).toEqual({ ok: true });
    expect(await signInStatus("cook@example.test", replacement)).toBe(200);
    const output = JSON.stringify([log.error.mock.calls, log.warn.mock.calls, log.log.mock.calls]);
    for (const secret of [password, replacement, "Synthetic-wrong-password-1!"]) expect(output).not.toContain(secret);
  });
  it("reports the rate limit and an unauthenticated request without leaking detail", async () => {
    expect(await setAccountPassword({ newPassword: password })).toEqual({ ok: false, error: "Sign in again before changing your password." });
    const cookie = await signUp("cook@example.test");
    vi.mocked(nextHeaders).mockResolvedValue(as(cookie));
    await setAccountPassword({ newPassword: password });
    for (let attempt = 0; attempt < 4; attempt++) await changeAccountPassword({ currentPassword: "Synthetic-wrong-password-1!", newPassword: replacement });
    expect(await changeAccountPassword({ currentPassword: password, newPassword: replacement }))
      .toEqual({ ok: false, error: "Too many attempts. Wait a minute before trying again." });
  });
});

describe("household rename", () => {
  beforeEach(async () => {
    await h.db.insert(s.households).values([{ id: "kitchen-a", name: "A kitchen" }, { id: "kitchen-b", name: "B kitchen" }]);
    await h.db.insert(s.authUsers).values([
      { id: "owner", name: "Owner", email: "owner@example.test", emailVerified: true },
      { id: "member", name: "Member", email: "member@example.test", emailVerified: true },
      { id: "outsider", name: "Outsider", email: "outsider@example.test", emailVerified: true },
      { id: "unverified", name: "Unverified", email: "unverified@example.test", emailVerified: false },
    ]);
    await h.db.insert(s.householdMembers).values([
      { householdId: "kitchen-a", userId: "owner", role: "owner" },
      { householdId: "kitchen-a", userId: "member", role: "member" },
      { householdId: "kitchen-b", userId: "outsider", role: "owner" },
      { householdId: "kitchen-a", userId: "unverified", role: "owner" },
    ]);
  });
  const names = async () => Object.fromEntries((await h.db.select().from(s.households)).map((row) => [row.id, row.name]));

  it("lets an owner rename only their own household, trimming the name", async () => {
    expect(await renameHousehold(h.db, "owner", "kitchen-a", "  Singh family  ")).toEqual({ householdId: "kitchen-a", name: "Singh family" });
    expect(await names()).toEqual({ "kitchen-a": "Singh family", "kitchen-b": "B kitchen" });
  });
  it("refuses a plain member, a non-member guessing an id, an unverified owner and a missing household", async () => {
    for (const [user, id] of [["member", "kitchen-a"], ["owner", "kitchen-b"], ["outsider", "kitchen-a"], ["unverified", "kitchen-a"], ["owner", "missing"]] as const) {
      await expect(renameHousehold(h.db, user, id, "Hijacked")).rejects.toThrow();
    }
    expect(await names()).toEqual({ "kitchen-a": "A kitchen", "kitchen-b": "B kitchen" });
  });
  it("rejects blank and over-long names", async () => {
    await expect(renameHousehold(h.db, "owner", "kitchen-a", "   ")).rejects.toThrow();
    await expect(renameHousehold(h.db, "owner", "kitchen-a", "x".repeat(101))).rejects.toThrow();
    expect((await names())["kitchen-a"]).toBe("A kitchen");
  });
  it("is exposed as an action bound to the verified session, returning messages instead of throwing", async () => {
    vi.mocked(verifiedSessionIdentity).mockResolvedValue({ userId: "member", sessionId: "member-session" });
    expect(await renameHouseholdAction("kitchen-a", "Nope")).toEqual({ ok: false, error: "Only a household owner can rename the household." });
    vi.mocked(verifiedSessionIdentity).mockResolvedValue({ userId: "owner", sessionId: "owner-session" });
    expect(await renameHouseholdAction("kitchen-b", "Nope")).toEqual({ ok: false, error: "This household is not available to your verified account." });
    expect(await renameHouseholdAction("kitchen-a", "")).toEqual({ ok: false, error: "Enter a household name." });
    expect(await renameHouseholdAction("kitchen-a", "Our kitchen")).toEqual({ ok: true, name: "Our kitchen" });
    expect((await names())["kitchen-a"]).toBe("Our kitchen");
  });
});
