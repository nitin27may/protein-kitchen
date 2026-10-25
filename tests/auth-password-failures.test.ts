import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { createAuth, type AuthCodeMail } from "../lib/auth/create";
import { accountHasPassword, takePasswordAttempt } from "../lib/auth/password";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("../lib/auth/password", async (original) => {
  const actual = await original<typeof import("../lib/auth/password")>();
  return { ...actual, accountHasPassword: vi.fn(actual.accountHasPassword), takePasswordAttempt: vi.fn(actual.takePasswordAttempt) };
});

let h: DbHandle;
let auth: ReturnType<typeof createAuth>;
let mailbox: AuthCodeMail[];
const origin = "http://localhost:3114";
const password = "Synthetic-failure-password-123!";
const replacement = "Synthetic-failure-replacement-456!";

beforeAll(async () => { h = await openDb(); });
beforeEach(() => {
  mailbox = [];
  auth = createAuth(h.db, {
    baseURL: origin, secret: "synthetic-password-failure-secret-32chars", isVercel: false,
    sendLink: async () => {}, sendCode: async (mail) => { mailbox.push(mail); },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

function call(path: string, body: object) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "198.51.100.12" },
    body: JSON.stringify(body),
  }));
}
async function signUp(email = "cook@example.test") {
  expect((await call("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
  const otp = mailbox.findLast((mail) => mail.email === email && mail.type === "sign-in")!.otp;
  const response = await call("/sign-in/email-otp", { email, otp });
  expect(response.status).toBe(200);
  const headers = new Headers({ cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") });
  const [user] = await h.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
  return { headers, userId: user!.id };
}
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("password changes that fail after the pre-checks", () => {
  it("refuses a session whose email is no longer verified, for set and change", async () => {
    const { headers, userId } = await signUp();
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, userId));
    expect(await auth.api.setPassword({ headers, newPassword: password })).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await auth.api.changePassword({ headers, currentPassword: password, newPassword: replacement })).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await accountHasPassword(h.db, userId)).toBe(false);
  });
  it("reports the rate limit on set without touching the credential", async () => {
    const { headers, userId } = await signUp();
    vi.mocked(takePasswordAttempt).mockResolvedValueOnce(false);
    expect(await auth.api.setPassword({ headers, newPassword: password })).toEqual({ ok: false, reason: "rate-limited" });
    expect(await accountHasPassword(h.db, userId)).toBe(false);
  });
  it("maps a set that lost a race to already-set and keeps the first password", async () => {
    const { headers, userId } = await signUp();
    expect(await auth.api.setPassword({ headers, newPassword: password })).toEqual({ ok: true });
    vi.mocked(accountHasPassword).mockResolvedValueOnce(false);
    expect(await auth.api.setPassword({ headers, newPassword: replacement })).toEqual({ ok: false, reason: "already-set" });
    expect((await call("/sign-in/email", { email: "cook@example.test", password })).status).toBe(200);
    expect(await accountHasPassword(h.db, userId)).toBe(true);
  });
  it("maps a session that ended mid-request to unauthenticated", async () => {
    const { headers } = await signUp();
    vi.mocked(takePasswordAttempt).mockImplementationOnce(async (db, id) => {
      await db.delete(s.authSessions);
      return true;
    });
    expect(await auth.api.setPassword({ headers, newPassword: password })).toEqual({ ok: false, reason: "unauthenticated" });
  });
  it("reports unavailable, without logging detail, when the provider refuses for another reason", async () => {
    const error = quiet();
    const { headers } = await signUp();
    vi.mocked(accountHasPassword).mockResolvedValueOnce(true);
    expect(await auth.api.changePassword({ headers, currentPassword: password, newPassword: replacement })).toEqual({ ok: false, reason: "unavailable" });
    expect(error).toHaveBeenCalledWith("Password change failed.");
    expect(JSON.stringify(error.mock.calls)).not.toContain(replacement);
  });
  it("reports unavailable when storage fails while changing the password", async () => {
    const error = quiet();
    const { headers, userId } = await signUp();
    expect(await auth.api.setPassword({ headers, newPassword: password })).toEqual({ ok: true });
    await h.db.execute(sql`create function reject_account_update() returns trigger language plpgsql as $$ begin raise exception 'Synthetic account failure'; end $$`);
    await h.db.execute(sql`create trigger reject_account_update before update on auth_accounts for each row execute function reject_account_update()`);
    try {
      expect(await auth.api.changePassword({ headers, currentPassword: password, newPassword: replacement })).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      await h.db.execute(sql`drop trigger reject_account_update on auth_accounts`);
      await h.db.execute(sql`drop function reject_account_update()`);
    }
    expect(error).toHaveBeenCalledWith("Password change failed.");
    expect((await call("/sign-in/email", { email: "cook@example.test", password })).status).toBe(200);
    expect(await accountHasPassword(h.db, userId)).toBe(true);
  });
});
