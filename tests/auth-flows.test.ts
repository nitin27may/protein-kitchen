import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError, eq, getTableName, sql } from "drizzle-orm";
import { createAuth, type AuthCodeMail } from "../lib/auth/create";
import { acceptInvitation, claimHousehold, createMemberProfile, issueInvitation } from "../lib/auth/household";
import * as s from "../lib/db/schema";
import { parseSignupAllowlist } from "../lib/auth/allowlist";
import { limitedSender } from "../lib/auth/mail-limits";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let auth: ReturnType<typeof createAuth>;
let mailbox: AuthCodeMail[];
const origin = "http://localhost:3112";
const bootstrap = "synthetic-bootstrap-key-for-auth-flow-tests";
const password = "Synthetic-password-123!";
const options = { baseURL: origin, secret: "synthetic-auth-flow-session-secret-32chars", isVercel: false,
  sendLink: async () => {} };
beforeAll(async () => { h = await openDb(); });
beforeEach(() => {
  mailbox = [];
  auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

function call(path: string, body?: object, headers: Record<string, string> = {}) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.1", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }));
}
const setupAddress = { "x-forwarded-for": "198.51.100.7" };
/** Open signup: a proven six-digit sign-in code is the only way an account is created. */
async function signUpByCode(email = "owner@example.test", headers: Record<string, string> = setupAddress) {
  const sent = await call("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers);
  expect(sent.status, await sent.clone().text()).toBe(200);
  return call("/sign-in/email-otp", { email, otp: latestCode("sign-in", email) }, headers);
}
async function setPassword(email = "owner@example.test") {
  expect((await call("/email-otp/request-password-reset", { email }, setupAddress)).status).toBe(200);
  const reset = await call("/email-otp/reset-password", { email, otp: latestCode("forget-password", email), password }, setupAddress);
  expect(reset.status, await reset.clone().text()).toBe(200);
}
function latestCode(type: AuthCodeMail["type"], email = "owner@example.test") {
  const mail = mailbox.findLast((entry) => entry.email === email && entry.type === type);
  if (!mail) throw new Error(`Expected synthetic ${type} email.`);
  return mail.otp;
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function verifiedOwner() {
  const response = await signUpByCode();
  expect(response.status, await response.clone().text()).toBe(200);
  await setPassword();
  const [owner] = await h.db.select().from(s.authUsers);
  await claimHousehold(h.db, owner!.id, bootstrap, bootstrap);
  return owner!.id;
}
async function passwordLogin(email = "owner@example.test", value = password) {
  return call("/sign-in/email", { email, password: value });
}
async function addOwnerDevice(userId: string) {
  const { id: personId } = await createMemberProfile(h.db, userId, {
    name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
  });
  await h.db.insert(s.pushSubscriptions).values({
    personId, endpoint: "https://push.example.test/owner-device", p256dh: "synthetic-key", auth: "synthetic-auth", createdAt: new Date().toISOString(),
  });
}

async function deletionSession() {
  await addOwnerDevice(await verifiedOwner());
  await h.db.insert(s.authUsers).values({ id: "surviving-owner", name: "Synthetic survivor", email: "survivor@example.test", emailVerified: true });
  const [household] = await h.db.select().from(s.households);
  await h.db.insert(s.householdMembers).values({ householdId: household!.id, userId: "surviving-owner", role: "owner" });
  await createMemberProfile(h.db, "surviving-owner", {
    name: "Surviving owner profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: null, reminderTime: null,
  });
  return cookies(await passwordLogin());
}

describe("rate-limited Better Auth household account deletion", () => {
  it("verifies the actual current password, clears cookies and denies every previous session", async () => {
    const cookie = await deletionSession();
    const secondCookie = cookies(await passwordLogin());
    const profile = await h.db.select().from(s.people);
    expect((await call("/delete-household-account", { password: "wrong-password", confirmation: "DELETE" }, { cookie })).status).toBe(403);
    const response = await call("/delete-household-account", { password, confirmation: "DELETE" }, { cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.getSetCookie().join(";")).toMatch(/session_token=;.*Max-Age=0/i);
    expect(await h.db.select().from(s.people)).toEqual(profile);
    expect(await h.db.select().from(s.authUsers)).toMatchObject([{ id: "surviving-owner" }]);
    expect(await h.db.select().from(s.authAccounts)).toEqual([]);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
    for (const stale of [cookie, secondCookie]) {
      expect(await (await call("/get-session", undefined, { cookie: stale })).json()).toBeNull();
      expect((await call("/delete-household-account", { password, confirmation: "DELETE" }, { cookie: stale })).status).toBe(401);
    }
    expect((await passwordLogin()).status).toBe(401);
    expect((await signUpByCode("fresh-after-delete@example.test")).status).toBe(200);
    expect(await h.db.select().from(s.householdBootstrap)).toHaveLength(1);
  });
  it("refuses missing sessions, foreign origins and injected targets before deletion", async () => {
    const cookie = await deletionSession();
    const body = { password, confirmation: "DELETE" };
    expect((await call("/delete-household-account", body)).status).toBe(401);
    expect((await call("/delete-household-account", body, { cookie, origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await call("/delete-household-account", { ...body, userId: "surviving-owner" }, { cookie })).status).toBe(400);
    expect((await call("/delete-household-account", { password, confirmation: "delete" }, { cookie })).status).toBe(400);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(2);
    expect((await call("/delete-user", { password }, { cookie })).status).not.toBe(200);
    expect((await call("/verify-password", { password }, { cookie })).status).toBe(200);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(2);
  });
  it.each(["/delete-household-account", "/verify-password"])("persists a password-guessing limit across auth factories for %s", async (path) => {
    const cookie = await deletionSession();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await call(path, { password: "wrong", confirmation: "DELETE" }, { cookie })).status).toBe(path === "/verify-password" ? 400 : 403);
    }
    auth = createAuth(h.db, { ...options, sendCode: async () => {} });
    expect((await call(path, { password, confirmation: "DELETE" }, { cookie })).status).toBe(429);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(2);
  });
  it("does not report success or clear cookies on transactional failure", async () => {
    const cookie = await deletionSession();
    await h.failWrite("auth_users", "DELETE", "reject_http_deletion");
    try {
      const response = await call("/delete-household-account", { password, confirmation: "DELETE" }, { cookie });
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie().join(";")).not.toContain("Max-Age=0");
      expect(await h.db.select().from(s.authUsers)).toHaveLength(2);
      expect(await h.db.select().from(s.pushSubscriptions)).toHaveLength(1);
      expect(await (await call("/get-session", undefined, { cookie })).json()).toMatchObject({ user: { email: "owner@example.test" } });
    } finally { await h.dropFailure("auth_users", "reject_http_deletion"); }
  });
});

describe("real Better Auth HTTP signup, verification and sessions", () => {
  it("rejects malformed reset JSON without creating or removing devices", async () => {
    const response = await auth.handler(new Request(`${origin}/api/auth/email-otp/reset-password`, {
      method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: "{",
    }));
    expect(response.status).toBe(400);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual([]);
  });
  it("creates a verified user only from a proven, hashed code, with no household membership", async () => {
    const wrong = await call("/sign-in/email-otp", { email: "owner@example.test", otp: "000000" });
    expect(wrong.status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    expect((await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).status).toBe(200);
    const code = latestCode("sign-in");
    expect(code).toMatch(/^\d{6}$/);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    const stored = await h.db.select().from(s.authVerifications);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code);
    const signedIn = await call("/sign-in/email-otp", { email: "owner@example.test", otp: code });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = cookies(signedIn);
    expect(cookie).toContain("session_token=");
    expect(await (await call("/get-session", undefined, { cookie })).json()).toMatchObject({
      user: { email: "owner@example.test", emailVerified: true },
    });
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
    expect((await call("/sign-out", {}, { cookie })).status).toBe(200);
    expect(await (await call("/get-session", undefined, { cookie })).json()).toBeNull();
  });

  it("does not ask for an invitation or claim key, and an invited address still signs up by code alone", async () => {
    const ownerId = await verifiedOwner();
    const invitation = await issueInvitation(h.db, ownerId, { email: "cook@example.test" });
    expect((await signUpByCode("cook@example.test")).status).toBe(200);
    const [cook] = await h.db.select().from(s.authUsers).where(eq(s.authUsers.email, "cook@example.test"));
    expect(cook).toMatchObject({ emailVerified: true });
    expect(await acceptInvitation(h.db, cook!.id, invitation.token)).toMatchObject({ role: "member" });
    expect((await signUpByCode("stranger@example.test")).status).toBe(200);
    expect(await h.db.select().from(s.householdBootstrap)).toHaveLength(1);
    expect(await h.db.select().from(s.householdMembers)).toHaveLength(2);
  });

  it("resets a password with a single-use code and revokes all previous sessions", async () => {
    await addOwnerDevice(await verifiedOwner());
    const first = await passwordLogin();
    const cookie = cookies(first);
    expect((await call("/email-otp/request-password-reset", { email: "owner@example.test" })).status).toBe(200);
    const code = latestCode("forget-password");
    const newPassword = "Synthetic-replacement-password-456!";
    const response = await call("/email-otp/reset-password", { email: "owner@example.test", otp: code, password: newPassword });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual([]);
    expect(await (await call("/get-session", undefined, { cookie })).json()).toBeNull();
    expect((await passwordLogin()).status).toBe(401);
    expect((await passwordLogin("owner@example.test", newPassword)).status).toBe(200);
    expect((await call("/email-otp/reset-password", { email: "owner@example.test", otp: code, password })).status).not.toBe(200);
  });

  it("disables the linked account's reminders on successful logout, without touching another profile's device", async () => {
    await addOwnerDevice(await verifiedOwner());
    const [other] = await h.db.insert(s.people).values({
      name: "Synthetic other profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await h.db.insert(s.pushSubscriptions).values({
      personId: other!.id, endpoint: "https://push.example.test/other-device", p256dh: "synthetic-key", auth: "synthetic-auth", createdAt: new Date().toISOString(),
    });
    const signedIn = await passwordLogin();
    expect((await call("/sign-out", {}, { cookie: cookies(signedIn) })).status).toBe(200);
    expect(await h.db.select().from(s.pushSubscriptions)).toMatchObject([{ personId: other!.id }]);
  });

  it("logs in with an email code and rejects reuse of a spent code", async () => {
    await verifiedOwner();
    expect((await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).status).toBe(200);
    const code = latestCode("sign-in");
    const response = await call("/sign-in/email-otp", { email: "owner@example.test", otp: code });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await (await call("/get-session", undefined, { cookie: cookies(response) })).json()).toMatchObject({
      user: { email: "owner@example.test" },
    });
    expect((await call("/sign-in/email-otp", { email: "owner@example.test", otp: code })).status).not.toBe(200);
    expect((await call("/sign-in/email-otp", { email: "unknown@example.test", otp: "000000" })).status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(1);
  });

  it("removes password signup and creates no user from any other unproven path", async () => {
    for (const headers of [{} as Record<string, string>, { "x-household-bootstrap": bootstrap }]) {
      const response = await call("/sign-up/email", { name: "Synthetic cook", email: "owner@example.test", password }, headers);
      expect(response.status).toBe(400);
    }
    expect((await call("/email-otp/verify-email", { email: "ghost@example.test", otp: "123456" })).status).not.toBe(200);
    expect((await call("/email-otp/check-verification-otp", { email: "ghost@example.test", type: "sign-in", otp: "123456" })).status).not.toBe(200);
    const link = await call("/magic-link/verify?token=not-a-real-token&callbackURL=%2Fonboarding&newUserCallbackURL=%2Fonboarding&errorCallbackURL=%2Fsign-in%3FemailLinkError%3D1");
    expect(link.status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("rejects wrong codes, burns the code after three wrong attempts and never creates the user", async () => {
    expect((await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).status).toBe(200);
    const code = latestCode("sign-in");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await call("/sign-in/email-otp", { email: "owner@example.test", otp: wrong })).status).not.toBe(200);
    }
    expect((await call("/sign-in/email-otp", { email: "owner@example.test", otp: code }, { "x-forwarded-for": "127.0.0.3" })).status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("rejects an expired code", async () => {
    expect((await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).status).toBe(200);
    await h.db.update(s.authVerifications).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call("/sign-in/email-otp", { email: "owner@example.test", otp: latestCode("sign-in") }, { "x-forwarded-for": "127.0.0.2" })).status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("surfaces awaited email delivery failure without logging the code or provider response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    auth = createAuth(h.db, { ...options, sendCode: async () => { throw new Error("synthetic-secret-provider-error"); } });
    const response = await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" });
    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toMatchObject({ message: "We could not send the email code. Please try again." });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret-provider-error");
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
  });

  it("rejects foreign request origins before any account or mail is created", async () => {
    for (const [path, body] of [
      ["/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" }],
      ["/sign-in/email-otp", { email: "owner@example.test", otp: "123456" }],
    ] as const) {
      expect((await call(path, body, { origin: "https://untrusted.example.test" })).status).toBe(403);
    }
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    expect(mailbox).toEqual([]);
  });

  it("persists request limits across auth instances and returns HTTP 429 with retry advice", async () => {
    for (let n = 0; n < 5; n++) expect((await call("/sign-in/email-otp", { email: `guess${n}@example.test`, otp: "000000" })).status).not.toBe(429);
    auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
    const limited = await call("/sign-in/email-otp", { email: "owner@example.test", otp: "000000" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await h.db.select().from(s.authRateLimits)).not.toEqual([]);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("refuses missing/spoofed IP chains and only trusts Vercel's overwritten header on Vercel", async () => {
    auth = createAuth(h.db, { ...options, isVercel: true, sendCode: async (mail) => { mailbox.push(mail); } });
    const send = (headers: Record<string, string>) => call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" }, headers);
    expect((await send({})).status).toBe(400);
    expect((await send({ "x-vercel-forwarded-for": "127.0.0.1, 203.0.113.1" })).status).toBe(400);
    expect((await send({ "x-vercel-forwarded-for": "203.0.113.1" })).status).toBe(200);
  });

  it("keeps a delivery failure isolated to its own request and allows a subsequent resend", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      auth = createAuth(h.db, { ...options, sendCode: async (mail) => {
        if (mail.email === "failed@example.test") throw new Error("synthetic failure");
        mailbox.push(mail);
      } });
      const send = (email: string) => call("/email-otp/send-verification-otp", { email, type: "sign-in" });
      const responses = await Promise.all([send("failed@example.test"), send("success@example.test")]);
      expect(responses.map((response) => response.status)).toEqual([503, 200]);
      auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
      expect((await send("failed@example.test")).status).toBe(200);
      expect(latestCode("sign-in", "failed@example.test")).toMatch(/^\d{6}$/);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("refuses a code request without an origin and does not allow server-side auth mutations to bypass limits", async () => {
    const response = await auth.handler(new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ email: "owner@example.test", type: "sign-in" }),
    }));
    expect(response.status).toBe(403);
    // Only the two password wrappers (own per-user limiter, covered in account-password.test.ts) join getSession.
    expect(Object.keys(auth.api)).toEqual(["getSession", "setPassword", "changePassword"]);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("rolls password reset, session revocation and code consumption back together after a database failure", async () => {
    await verifiedOwner();
    const cookie = cookies(await passwordLogin());
    expect((await call("/email-otp/request-password-reset", { email: "owner@example.test" })).status).toBe(200);
    const code = latestCode("forget-password");
    const newPassword = "Synthetic-new-password-456!";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.failWrite("auth_accounts", "UPDATE", "reject_password_reset");
    try {
      const response = await call("/email-otp/reset-password", { email: "owner@example.test", otp: code, password: newPassword });
      expect(response.status).toBe(500);
      expect(await (await call("/get-session", undefined, { cookie })).json()).toMatchObject({ user: { email: "owner@example.test" } });
      expect((await passwordLogin()).status).toBe(200);
    } finally {
      await h.dropFailure("auth_accounts", "reject_password_reset");
      log.mockRestore();
    }
    expect((await call("/email-otp/reset-password", { email: "owner@example.test", otp: code, password: newPassword })).status).toBe(200);
    expect(await (await call("/get-session", undefined, { cookie })).json()).toBeNull();
  });

  it("returns input errors for malformed code requests rather than disguising them as server errors", async () => {
    expect((await call("/email-otp/send-verification-otp", { email: "invalid", type: "sign-in" })).status).toBe(400);
    expect((await call("/email-otp/send-verification-otp", { email: 7, type: "sign-in" })).status).toBe(400);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("returns the same response for an existing and a new address before any proof", async () => {
    await verifiedOwner();
    const existing = await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" });
    const fresh = await call("/email-otp/send-verification-otp", { email: "new-person@example.test", type: "sign-in" });
    expect(existing.status).toBe(200);
    expect(fresh.status).toBe(existing.status);
    expect(await fresh.text()).toBe(await existing.text());
    expect(await h.db.select().from(s.authUsers)).toHaveLength(1);
  });

  it("reads the same cookie through the server session helper and observes sign-out immediately", async () => {
    await verifiedOwner();
    const cookie = cookies(await passwordLogin());
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toMatchObject({ user: { email: "owner@example.test" } });
    expect((await call("/sign-out", {}, { cookie })).status).toBe(200);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it("redacts SQL parameters on an unexpected persistent limiter failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const select = vi.spyOn(h.db, "select").mockImplementationOnce(() => {
      throw new DrizzleQueryError("select private_auth_fixture", ["synthetic-private-session-token"], new Error("synthetic database failure"));
    });
    try {
      await expect(call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).rejects.toThrow("The authentication database is unavailable.");
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-session-token");
    } finally { select.mockRestore(); log.mockRestore(); }
  });

  it("does not hide unexpected programming failures in the persistent limiter", async () => {
    const select = vi.spyOn(h.db, "select").mockImplementationOnce(() => { throw new TypeError("synthetic programming failure"); });
    try { await expect(call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" })).rejects.toThrow("synthetic programming failure"); }
    finally { select.mockRestore(); }
  });
});

describe("mail caps and the signup allowlist over real HTTP", () => {
  const allowlist = parseSignupAllowlist("friend@example.test,@family.example.test");
  const secret = options.secret;
  let delivered: string[];
  function build(dailyCap = 60, list = allowlist) {
    const send = limitedSender(h.db, { secret, dailyCap, allowlist: list }, async (mail) => { delivered.push(`${mail.type}:${mail.email}`); });
    auth = createAuth(h.db, {
      ...options, signupAllowlist: list,
      sendCode: async (mail) => { mailbox.push(mail); await send(mail); }, sendLink: send,
    });
  }
  const request = (email: string, headers = setupAddress) => call("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers);
  beforeEach(() => { delivered = []; build(); });

  it("answers byte-identically for an allowlisted, an existing, an invited and a blocked address, and mails only the first three", async () => {
    await h.db.insert(s.authUsers).values({ id: "ex", name: "Existing", email: "existing@example.test", emailVerified: true });
    await h.db.insert(s.authUsers).values({ id: "own", name: "Owner", email: "own@family.example.test", emailVerified: true });
    await h.db.insert(s.households).values({ id: "hh", name: "Kitchen" });
    await h.db.insert(s.householdInvitations).values({
      householdId: "hh", id: "inv", email: "invited@elsewhere.test", invitedByUserId: "own", expiresAt: new Date(Date.now() + 86_400_000),
    });
    const bodies: string[] = [];
    for (const email of ["friend@example.test", "existing@example.test", "invited@elsewhere.test", "stranger@elsewhere.test"]) {
      const response = await request(email);
      expect(response.status, email).toBe(200);
      bodies.push(`${response.status} ${response.headers.get("content-type")} ${response.headers.get("cache-control")} ${await response.text()}`);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(delivered).toEqual([
      "sign-in:friend@example.test", "sign-in:existing@example.test", "sign-in:invited@elsewhere.test",
    ]);
  });
  it("gives a blocked address the same failure as an allowed one once the cap is hit, and never mails it", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await request("stranger@elsewhere.test")).status);
    for (let i = 0; i < 4; i++) statuses.push((await request("friend@example.test", { "x-forwarded-for": "198.51.100.8" })).status);
    expect(statuses).toEqual([200, 200, 200, 503, 200, 200, 200, 503]);
    expect(delivered).toHaveLength(3);
  });
  it("enforces the global cap with the generic delivery failure and no provider call", async () => {
    build(2);
    expect((await request("friend@example.test")).status).toBe(200);
    expect((await request("friend2@family.example.test")).status).toBe(200);
    const capped = await request("friend3@family.example.test");
    expect(capped.status).toBe(503);
    expect(await capped.json()).toEqual({ message: "We could not send the email code. Please try again." });
    expect(delivered).toHaveLength(2);
  });
  it("refuses to create an account for a non-allowlisted address even with a valid code, and admits listed and invited ones", async () => {
    // A code can only exist for an address that was mailed, so mint one for an unlisted address with open signup first.
    build(60, null);
    const unlisted = "late@elsewhere.test";
    expect((await request(unlisted)).status).toBe(200);
    const otp = latestCode("sign-in", unlisted);
    build();
    const refused = await call("/sign-in/email-otp", { email: unlisted, otp }, setupAddress);
    expect(refused.status).toBe(403);
    expect((await h.db.select().from(s.authUsers)).map((u) => u.email)).not.toContain(unlisted);
    expect((await signUpByCode("friend@example.test")).status).toBe(200);
    await h.db.insert(s.households).values({ id: "hh", name: "Kitchen" });
    await h.db.insert(s.householdInvitations).values({
      householdId: "hh", id: "inv", email: "invited@elsewhere.test", invitedByUserId: (await h.db.select().from(s.authUsers))[0]!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await signUpByCode("invited@elsewhere.test")).status).toBe(200);
  });
  it("lets the email link route follow the same gate", async () => {
    const link = await call("/sign-in/magic-link", {
      email: "stranger@elsewhere.test", callbackURL: "/onboarding", newUserCallbackURL: "/onboarding", errorCallbackURL: "/sign-in?emailLinkError=1",
    });
    expect(link.status).toBe(200);
    expect(delivered).toEqual([]);
  });
});
