import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError, eq, getTableName, sql } from "drizzle-orm";
import { createAuth, type AuthCodeMail } from "../lib/auth/create";
import { acceptInvitation, claimHousehold, createMemberProfile, issueInvitation, revokeInvitation } from "../lib/auth/household";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let auth: ReturnType<typeof createAuth>;
let mailbox: AuthCodeMail[];
const origin = "http://localhost:3112";
const bootstrap = "synthetic-bootstrap-key-for-auth-flow-tests";
const password = "Synthetic-password-123!";
const options = { baseURL: origin, secret: "synthetic-auth-flow-session-secret-32chars", bootstrapSecret: bootstrap, isVercel: false };
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
function signup(email = "owner@example.test", admission: Record<string, string> = { "x-household-bootstrap": bootstrap }) {
  return call("/sign-up/email", { name: "Synthetic cook", email, password }, admission);
}
function latestCode(type: AuthCodeMail["type"], email = "owner@example.test") {
  const mail = mailbox.findLast((entry) => entry.email === email && entry.type === type);
  if (!mail) throw new Error(`Expected synthetic ${type} email.`);
  return mail.otp;
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function verifiedOwner() {
  const response = await signup();
  expect(response.status, await response.clone().text()).toBe(200);
  const verified = await call("/email-otp/verify-email", { email: "owner@example.test", otp: latestCode("email-verification") });
  expect(verified.status, await verified.clone().text()).toBe(200);
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
    expect((await signup("cannot-rebootstrap@example.test")).status).toBe(403);
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
  it("requires signup admission, verifies a hashed code and restores only a valid server session", async () => {
    expect((await signup("outsider@example.test", { "x-household-bootstrap": "" })).status).toBe(403);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    const response = await signup();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
    const code = latestCode("email-verification");
    expect(code).toMatch(/^\d{6}$/);
    const stored = await h.db.select().from(s.authVerifications);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect((await passwordLogin()).status).toBe(403);
    expect((await call("/email-otp/verify-email", { email: "owner@example.test", otp: code })).status).toBe(200);
    const signedIn = await passwordLogin();
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

  it("accepts an invited second account without making a second household or exposing admission to later requests", async () => {
    const ownerId = await verifiedOwner();
    const invitation = await issueInvitation(h.db, ownerId, { email: "cook@example.test" });
    expect((await signup("cook@example.test", { "x-household-bootstrap": "", "x-household-invitation": invitation.token })).status).toBe(200);
    expect((await call("/email-otp/verify-email", { email: "cook@example.test", otp: latestCode("email-verification", "cook@example.test") })).status).toBe(200);
    const [cook] = await h.db.select().from(s.authUsers).where(eq(s.authUsers.email, "cook@example.test"));
    expect(await acceptInvitation(h.db, cook!.id, invitation.token)).toMatchObject({ role: "member" });
    expect((await signup("another@example.test")).status).toBe(403);
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

  it("logs in with an email code and rejects reuse without auto-registering unknown accounts", async () => {
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

  it("requires a matching, unrevoked invitation for registration", async () => {
    const ownerId = await verifiedOwner();
    const invitation = await issueInvitation(h.db, ownerId, { email: "cook@example.test" });
    expect((await signup("wrong@example.test", { "x-household-bootstrap": "", "x-household-invitation": invitation.token })).status).toBe(403);
    await revokeInvitation(h.db, ownerId, invitation.id);
    expect((await signup("cook@example.test", { "x-household-bootstrap": "", "x-household-invitation": invitation.token })).status).toBe(403);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(1);
  });

  it("rejects wrong/expired verification codes and invalidates after three wrong attempts", async () => {
    expect((await signup()).status).toBe(200);
    const code = latestCode("email-verification");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await call("/email-otp/verify-email", { email: "owner@example.test", otp: wrong })).status).not.toBe(200);
    }
    expect((await call("/email-otp/verify-email", { email: "owner@example.test", otp: code })).status).not.toBe(200);
    expect((await call("/email-otp/send-verification-otp", { email: "owner@example.test", type: "email-verification" })).status).toBe(200);
    await h.db.update(s.authVerifications).set({ expiresAt: new Date(Date.now() - 1000) });
    // Use a different connecting address so the attempt-limit test does not proxy the expiry assertion.
    const expired = await call("/email-otp/verify-email", { email: "owner@example.test", otp: latestCode("email-verification") }, {
      "x-forwarded-for": "127.0.0.2",
    });
    expect(expired.status).not.toBe(200);
    expect(await h.db.select().from(s.authUsers)).toMatchObject([{ emailVerified: false }]);
  });

  it("surfaces awaited email delivery failure without logging the code or provider response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    auth = createAuth(h.db, { ...options, sendCode: async () => { throw new Error("synthetic-secret-provider-error"); } });
    const response = await signup();
    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toMatchObject({ message: "We could not send the email code. Please try again." });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret-provider-error");
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
  });

  it("rejects foreign request origins before any account or mail is created", async () => {
    const response = await call("/sign-up/email", { name: "Synthetic cook", email: "owner@example.test", password }, {
      origin: "https://untrusted.example.test", "x-household-bootstrap": bootstrap,
    });
    expect(response.status).toBe(403);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    expect(mailbox).toEqual([]);
  });

  it("rejects an external callback URL even from the trusted application origin", async () => {
    const response = await call("/sign-up/email", {
      name: "Synthetic", email: "owner@example.test", password, callbackURL: "https://untrusted.example.test/",
    }, { "x-household-bootstrap": bootstrap });
    expect(response.status).toBe(403);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
    expect(mailbox).toEqual([]);
  });

  it("persists request limits across auth instances and returns HTTP 429 with retry advice", async () => {
    for (let n = 0; n < 3; n++) expect((await signup(`unauthorized${n}@example.test`, { "x-household-bootstrap": "" })).status).toBe(403);
    auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
    const limited = await signup();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await h.db.select().from(s.authRateLimits)).not.toEqual([]);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("refuses missing/spoofed IP chains and only trusts Vercel's overwritten header on Vercel", async () => {
    auth = createAuth(h.db, { ...options, isVercel: true, sendCode: async (mail) => { mailbox.push(mail); } });
    expect((await signup()).status).toBe(400);
    expect((await signup("owner@example.test", {
      "x-household-bootstrap": bootstrap, "x-vercel-forwarded-for": "127.0.0.1, 203.0.113.1",
    })).status).toBe(400);
    expect((await signup("owner@example.test", {
      "x-household-bootstrap": bootstrap, "x-vercel-forwarded-for": "203.0.113.1",
    })).status).toBe(200);
  });

  it("keeps a delivery failure isolated to its own request and allows a subsequent resend", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      auth = createAuth(h.db, { ...options, sendCode: async (mail) => {
        if (mail.email === "failed@example.test") throw new Error("synthetic failure");
        mailbox.push(mail);
      } });
      const responses = await Promise.all([signup("failed@example.test"), signup("success@example.test")]);
      expect(responses.map((response) => response.status)).toEqual([503, 200]);
      auth = createAuth(h.db, { ...options, sendCode: async (mail) => { mailbox.push(mail); } });
      expect((await call("/email-otp/send-verification-otp", { email: "failed@example.test", type: "email-verification" })).status).toBe(200);
      expect(latestCode("email-verification", "failed@example.test")).toMatch(/^\d{6}$/);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("refuses signup without an origin and does not allow server-side auth mutations to bypass limits", async () => {
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1", "x-household-bootstrap": bootstrap },
      body: JSON.stringify({ email: "owner@example.test", name: "Synthetic", password }),
    }));
    expect(response.status).toBe(403);
    expect(Object.keys(auth.api)).toEqual(["getSession"]);
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

  it("returns input errors for malformed signup rather than disguising them as server errors", async () => {
    expect((await signup("invalid")).status).toBe(400);
    expect((await call("/sign-up/email", { name: "Synthetic", email: 7, password }, { "x-household-bootstrap": bootstrap })).status).toBe(400);
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
  });

  it("fails closed when signup admission cannot read its database", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.client.exec("ALTER TABLE household_bootstrap RENAME TO temporarily_unavailable_bootstrap");
    try {
      expect((await signup()).status).toBe(500);
      expect(log).toHaveBeenCalled();
    } finally {
      await h.client.exec("ALTER TABLE temporarily_unavailable_bootstrap RENAME TO household_bootstrap");
      log.mockRestore();
    }
    expect(await h.db.select().from(s.authUsers)).toEqual([]);
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
      await expect(signup()).rejects.toThrow("The authentication database is unavailable.");
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-session-token");
    } finally { select.mockRestore(); log.mockRestore(); }
  });

  it("does not hide unexpected programming failures in the persistent limiter", async () => {
    const select = vi.spyOn(h.db, "select").mockImplementationOnce(() => { throw new TypeError("synthetic programming failure"); });
    try { await expect(signup()).rejects.toThrow("synthetic programming failure"); }
    finally { select.mockRestore(); }
  });
});
