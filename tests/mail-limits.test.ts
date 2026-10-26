import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { isAllowlisted, parseSignupAllowlist, signupIsInviteOnly } from "../lib/auth/allowlist";
import type { AuthMail } from "../lib/auth/create";
import { limitedSender, MailLimitError, recipientHash } from "../lib/auth/mail-limits";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
const secret = "synthetic-mail-limit-secret-for-tests-32chars";
const code = (email: string, type: "sign-in" | "forget-password" = "sign-in"): AuthMail => ({ email, otp: "123456", type });
const open = { secret, dailyCap: 60, allowlist: null };
const rows = () => h.db.select().from(s.mailSends);

beforeAll(async () => { h = await openDb(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.db.delete(s.mailSends);
  await h.db.delete(s.householdInvitations);
  await h.db.delete(s.authUsers);
});

describe("recipient hash", () => {
  it("normalises, is keyed by the secret and is not the address", () => {
    expect(recipientHash(secret, " A@Example.test ")).toBe(recipientHash(secret, "a@example.test"));
    expect(recipientHash(secret, "a@example.test")).not.toBe(recipientHash(`${secret}-other`, "a@example.test"));
    expect(recipientHash(secret, "a@example.test")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("stores no address in the ledger", async () => {
    await limitedSender(h.db, open, async () => {})(code("Stored@Example.test"));
    expect(JSON.stringify(await rows())).not.toMatch(/stored|example/i);
  });
});

describe("per-recipient caps", () => {
  it("allows 3 in 15 minutes then refuses without calling the provider", async () => {
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, open, send);
    for (let i = 0; i < 3; i++) await guarded(code("a@example.test"));
    await expect(guarded(code("a@example.test"))).rejects.toBeInstanceOf(MailLimitError);
    expect(send).toHaveBeenCalledTimes(3);
    await guarded(code("b@example.test"));
    expect(send).toHaveBeenCalledTimes(4);
  });
  // Rows are placed just after UTC midnight so they count for the day but sit outside the 15-minute window.
  // Within 20 minutes of UTC midnight that is impossible, so those two tests skip themselves.
  const nearMidnight = () => new Date().getUTCHours() === 0 && new Date().getUTCMinutes() < 20;
  const earlyToday = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 second'`;
  it("frees the window after 15 minutes but holds 7 earlier plus 3 new, 10 per UTC day", async () => {
    if (nearMidnight()) return;
    const hash = recipientHash(secret, "a@example.test");
    await h.db.execute(sql`insert into mail_sends (recipient_hash, purpose, created_at) select ${hash}, 'sign-in', ${earlyToday} from generate_series(1, 7)`);
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, open, send);
    for (let i = 0; i < 3; i++) await guarded(code("a@example.test"));
    await expect(guarded(code("a@example.test"))).rejects.toBeInstanceOf(MailLimitError);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("refuses at 10 sends today even when none is inside the 15-minute window", async () => {
    if (nearMidnight()) return;
    const hash = recipientHash(secret, "day@example.test");
    await h.db.execute(sql`insert into mail_sends (recipient_hash, purpose, created_at) select ${hash}, 'sign-in', ${earlyToday} from generate_series(1, 10)`);
    const send = vi.fn(async () => {});
    await expect(limitedSender(h.db, open, send)(code("day@example.test"))).rejects.toBeInstanceOf(MailLimitError);
    expect(send).not.toHaveBeenCalled();
  });
  it("ignores rows from before the UTC day and prunes rows older than 2 days", async () => {
    const hash = recipientHash(secret, "old@example.test");
    await h.db.execute(sql`insert into mail_sends (recipient_hash, purpose, created_at) values
      (${hash}, 'sign-in', now() - interval '3 days'), (${hash}, 'sign-in', now() - interval '49 hours'), (${hash}, 'sign-in', now() - interval '47 hours')`);
    const send = vi.fn(async () => {});
    await limitedSender(h.db, open, send)(code("old@example.test"));
    expect(send).toHaveBeenCalledOnce();
    const left = await rows();
    expect(left).toHaveLength(2);
    expect(left.every((r) => Date.now() - r.createdAt.getTime() < 2 * 86_400_000)).toBe(true);
  });
});

describe("concurrency", () => {
  it("lets exactly one of two simultaneous sends take the last slot", async () => {
    const hash = recipientHash(secret, "race@example.test");
    await h.db.execute(sql`insert into mail_sends (recipient_hash, purpose) select ${hash}, 'sign-in' from generate_series(1, 2)`);
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, open, send);
    const results = await Promise.allSettled([guarded(code("race@example.test")), guarded(code("race@example.test"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
    expect(await rows()).toHaveLength(3);
  });
  it("holds the global cap under simultaneous sends to different recipients", async () => {
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, { ...open, dailyCap: 3 }, send);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => guarded(code(`g${i}@example.test`))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("global daily cap", () => {
  it("refuses any recipient once the cap is reached and does not count blocked addresses", async () => {
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, { ...open, dailyCap: 2 }, send);
    await guarded(code("a@example.test"));
    await guarded(code("b@example.test"));
    await expect(guarded(code("c@example.test"))).rejects.toBeInstanceOf(MailLimitError);
    expect(send).toHaveBeenCalledTimes(2);
    await h.db.delete(s.mailSends);
    const blocking = limitedSender(h.db, { ...open, dailyCap: 2, allowlist: parseSignupAllowlist("@friends.example.test") }, send);
    for (let i = 0; i < 3; i++) await blocking(code(`x${i}@stranger.example.test`));
    await blocking(code("in@friends.example.test"));
    await blocking(code("in2@friends.example.test"));
    await expect(blocking(code("in3@friends.example.test"))).rejects.toBeInstanceOf(MailLimitError);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("does not send when the ledger write fails", async () => {
    await h.failWrite("mail_sends", "INSERT", "reject_mail_ledger");
    const send = vi.fn(async () => {});
    try { await expect(limitedSender(h.db, open, send)(code("a@example.test"))).rejects.toThrow(); }
    finally { await h.dropFailure("mail_sends", "reject_mail_ledger"); }
    expect(send).not.toHaveBeenCalled();
  });
});

describe("signup allowlist", () => {
  const list = parseSignupAllowlist("friend@example.test, @family.example.test");
  it("matches addresses and whole domains only", () => {
    expect(isAllowlisted(list, "FRIEND@example.test")).toBe(true);
    expect(isAllowlisted(list, "anyone@family.example.test")).toBe(true);
    expect(isAllowlisted(list, "anyone@sub.family.example.test")).toBe(false);
    expect(isAllowlisted(list, "stranger@example.test")).toBe(false);
    expect(isAllowlisted(null, "anyone@example.test")).toBe(true);
    expect(signupIsInviteOnly({ SIGNUP_ALLOWLIST: "a@b.test" })).toBe(true);
    expect(signupIsInviteOnly({})).toBe(false);
  });
  it("sends nothing to an unknown, unlisted address but counts it", async () => {
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, { ...open, allowlist: list }, send);
    await guarded(code("stranger@example.test"));
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0]?.purpose).toBe("blocked:sign-in");
    await guarded(code("friend@example.test"));
    expect(send).toHaveBeenCalledOnce();
  });
  it("applies the same per-recipient cap to blocked and allowed addresses", async () => {
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, { ...open, allowlist: list }, send);
    for (const email of ["stranger@example.test", "friend@example.test"]) {
      for (let i = 0; i < 3; i++) await guarded(code(email));
      await expect(guarded(code(email)), email).rejects.toBeInstanceOf(MailLimitError);
    }
  });
  it("mails an existing account that is not on the list", async () => {
    await h.db.insert(s.authUsers).values({ id: "u1", name: "Existing", email: "Existing@Example.test", emailVerified: true });
    const send = vi.fn(async () => {});
    await limitedSender(h.db, { ...open, allowlist: list }, send)(code("existing@example.test", "forget-password"));
    expect(send).toHaveBeenCalledOnce();
  });
  it("mails an address with a pending household association, but not an expired or revoked one", async () => {
    await h.db.insert(s.authUsers).values({ id: "owner", name: "Owner", email: "owner@family.example.test", emailVerified: true });
    await h.db.insert(s.households).values({ id: "hh", name: "Kitchen" });
    const base = { householdId: "hh", invitedByUserId: "owner" };
    const day = 86_400_000;
    await h.db.insert(s.householdInvitations).values([
      { ...base, id: "i1", email: "pending@elsewhere.test", expiresAt: new Date(Date.now() + day) },
      { ...base, id: "i2", email: "revoked@elsewhere.test", expiresAt: new Date(Date.now() + day), revokedAt: new Date() },
      { ...base, id: "i3", email: "expired@elsewhere.test", createdAt: new Date(Date.now() - 2 * day), expiresAt: new Date(Date.now() - day) },
    ]);
    const send = vi.fn(async () => {});
    const guarded = limitedSender(h.db, { ...open, allowlist: list }, send);
    await guarded(code("pending@elsewhere.test"));
    expect(send).toHaveBeenCalledOnce();
    await guarded(code("revoked@elsewhere.test"));
    await guarded(code("expired@elsewhere.test"));
    expect(send).toHaveBeenCalledOnce();
  });
  it("always delivers the owner-initiated household association notice", async () => {
    const send = vi.fn(async () => {});
    await limitedSender(h.db, { ...open, allowlist: list }, send)({ email: "invitee@elsewhere.test", url: "https://k.example.test/sign-in", type: "household-association" });
    expect(send).toHaveBeenCalledOnce();
  });
});
