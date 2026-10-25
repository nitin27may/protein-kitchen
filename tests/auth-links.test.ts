import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getTableName, like, sql } from "drizzle-orm";
import { createAuth, type AuthLinkMail } from "../lib/auth/create";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

const origin = "http://localhost:3112";
const email = "link-owner@example.test";
const callbacks = { callbackURL: "/onboarding", newUserCallbackURL: "/onboarding", errorCallbackURL: "/sign-in?emailLinkError=1" };
let h: DbHandle;
let auth: ReturnType<typeof createAuth>;
let mailbox: AuthLinkMail[];
const options = {
  baseURL: origin, secret: "synthetic-email-link-session-secret-for-tests", isVercel: false,
  bootstrapSecret: "synthetic-link-bootstrap-secret-for-tests", sendCode: async () => {},
};
function provider(sendLink = async (mail: AuthLinkMail) => { mailbox.push(mail); }) {
  return createAuth(h.db, { ...options, sendLink });
}
function call(path: string, body?: object, headers: Record<string, string> = {}) {
  return auth.handler(new Request(path.startsWith(origin) ? path : `${origin}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.1", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }));
}
const send = (overrides: object = {}) => call("/sign-in/magic-link", { email, ...callbacks, ...overrides });
function latest() {
  const mail = mailbox.at(-1);
  if (!mail) throw new Error("Expected synthetic emailed link.");
  return new URL(mail.url);
}
async function user() {
  await h.db.insert(s.authUsers).values({ id: "link-owner", email, emailVerified: true, name: "Synthetic link owner" });
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
beforeAll(async () => { h = await openDb(); });
beforeEach(() => { mailbox = []; auth = provider(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

describe("provider-backed single-use email links", () => {
  it("stores only the hash, establishes a real opening-browser session and refuses replay", async () => {
    await user();
    expect((await send()).status).toBe(200);
    const url = latest();
    expect(url.origin).toBe(origin);
    expect(Object.fromEntries(url.searchParams)).toMatchObject(callbacks);
    const token = url.searchParams.get("token")!;
    const [record] = await h.db.select().from(s.authVerifications);
    expect(record!.identifier).toBe(`magic-link:${createHash("sha256").update(token).digest("base64url")}`);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record!.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
    expect(record!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const opened = await call(url.href);
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(`${origin}/onboarding`);
    expect(await (await call("/get-session", undefined, { cookie: cookies(opened) })).json()).toMatchObject({
      user: { email, emailVerified: true },
    });
    expect(await (await call("/get-session")).json()).toBeNull();
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);
    const replay = await call(url.href);
    expect(replay.headers.get("location")).toContain("error=INVALID_TOKEN");
    expect(cookies(replay)).toBe("");
    expect(await h.db.select().from(s.authSessions)).toHaveLength(1);
  });
  it("gives the same send response to an unknown mailbox without creating an account", async () => {
    await user();
    const known = await send();
    const missing = await send({ email: "missing@example.test" });
    expect(missing.status).toBe(known.status);
    expect(await missing.json()).toEqual(await known.json());
    const refused = await call(latest().href);
    expect(refused.headers.get("location")).toContain("new_user_signup_disabled");
    expect(cookies(refused)).toBe("");
    expect(await h.db.select().from(s.authUsers)).toHaveLength(1);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
  });
  it("refuses expired tokens and consumes them without establishing a session", async () => {
    await user();
    await send();
    await h.db.update(s.authVerifications).set({ expiresAt: new Date(Date.now() - 1_000) });
    const response = await call(latest().href);
    expect(response.headers.get("location")).toContain("INVALID_TOKEN");
    expect(cookies(response)).toBe("");
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
  });
  it("revokes pre-verification account links and sessions before proving an unverified mailbox", async () => {
    const signup = await call("/sign-up/email", { name: "Synthetic unverified", email, password: "Synthetic-preproof-password-123!" },
      { "x-household-bootstrap": options.bootstrapSecret });
    expect(signup.status).toBe(200);
    const [account] = await h.db.select().from(s.authUsers);
    expect(account!.emailVerified).toBe(false);
    expect(await h.db.select().from(s.authAccounts)).toHaveLength(1);
    await h.db.insert(s.authSessions).values({
      id: "preproof-session", userId: account!.id, token: "synthetic-preproof",
      expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
    });
    await send();
    const response = await call(latest().href);
    expect(response.headers.get("location")).toBe(`${origin}/onboarding`);
    expect(await h.db.select().from(s.authAccounts)).toEqual([]);
    expect(await h.db.select().from(s.authSessions)).toMatchObject([{ userId: account!.id }]);
    expect((await h.db.select().from(s.authSessions))[0]!.id).not.toBe("preproof-session");
    expect(await (await call("/get-session", undefined, { cookie: cookies(response) })).json()).toMatchObject({ user: { emailVerified: true } });
  });
  it("removes an unsent token, sanitizes delivery errors and permits a successful retry", async () => {
    await user();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    auth = provider(async () => { throw new Error("synthetic-private-mail-error"); });
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "We could not send the email link. Please try again." });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await h.db.select().from(s.authVerifications).where(like(s.authVerifications.identifier, "magic-link:%"))).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-mail-error");
    auth = provider();
    expect((await send()).status).toBe(200);
    expect((await call(latest().href)).headers.get("location")).toBe(`${origin}/onboarding`);
  });
  it("persists send throttling across provider instances", async () => {
    for (let attempt = 0; attempt < 5; attempt++) expect((await send()).status).toBe(200);
    auth = provider();
    expect((await send()).status).toBe(429);
    expect(mailbox).toHaveLength(5);
  });
  it("persists verification throttling across provider instances", async () => {
    const url = new URL(`${origin}/api/auth/magic-link/verify`);
    Object.entries({ ...callbacks, token: "invalid" }).forEach(([key, value]) => url.searchParams.set(key, value));
    for (let attempt = 0; attempt < 5; attempt++) expect((await call(url.href)).status).toBe(302);
    auth = provider();
    expect((await call(url.href)).status).toBe(429);
  });
  it.each(["callbackURL", "newUserCallbackURL", "errorCallbackURL"])("rejects injected %s before sending or consuming a token", async (field) => {
    await user();
    expect((await send({ [field]: "https://foreign.example.test" })).status).toBe(403);
    expect((await send({ [field]: "/account" })).status).toBe(400);
    expect(mailbox).toEqual([]);
    await send();
    const valid = latest();
    const injected = new URL(valid);
    injected.searchParams.set(field, "https://foreign.example.test");
    expect((await call(injected.href)).status).toBe(400);
    expect(await h.db.select().from(s.authSessions)).toEqual([]);
    expect((await call(valid.href)).headers.get("location")).toBe(`${origin}/onboarding`);
  });
  it("requires exact origin, a real connecting address and complete pinned callbacks", async () => {
    expect((await send({ callbackURL: undefined })).status).toBe(400);
    expect((await call("/sign-in/magic-link", { email, ...callbacks }, { origin: "https://foreign.example.test" })).status).toBe(403);
    expect((await call("/sign-in/magic-link", { email, ...callbacks }, { "x-forwarded-for": "invalid" })).status).toBe(400);
    expect((await call("/magic-link/verify?token=invalid")).status).toBe(400);
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);
  });
});
