import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { authAccounts, authRateLimits, authSessions } from "../db/schema";

/** Same bounds as the Better Auth emailAndPassword configuration and the reset-password screen. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const NewPassword = z.string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);
export const CurrentPassword = z.string().min(1, "Enter your current password.").max(PASSWORD_MAX_LENGTH, "That password is not correct.");

/** Matches the sign-in rule: five password attempts per user per minute, kept in the shared limiter table. */
export const PASSWORD_ATTEMPTS = { window: 60, max: 5 } as const;

/** Atomically counts one attempt; false once the window's allowance is spent. Persists across auth instances. */
export async function takePasswordAttempt(db: Db, userId: string, now = Date.now()) {
  const key = `account-password:${userId}`;
  const windowMs = PASSWORD_ATTEMPTS.window * 1000;
  const [row] = await db.insert(authRateLimits).values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: authRateLimits.key,
      set: {
        count: sql`case when ${authRateLimits.lastRequest} < ${now - windowMs} then 1 else ${authRateLimits.count} + 1 end`,
        lastRequest: sql`case when ${authRateLimits.lastRequest} < ${now - windowMs} then ${now} else ${authRateLimits.lastRequest} end`,
      },
    }).returning({ count: authRateLimits.count });
  return (row?.count ?? 1) <= PASSWORD_ATTEMPTS.max;
}

export async function accountHasPassword(db: Db, userId: string) {
  const [row] = await db.select({ password: authAccounts.password }).from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential"))).limit(1);
  return Boolean(row?.password);
}

/** A new credential signs out every other device; the session that made the change stays. */
export async function revokeOtherSessions(db: Db, userId: string, keepSessionId: string) {
  await db.delete(authSessions).where(and(eq(authSessions.userId, userId), ne(authSessions.id, keepSessionId)));
}

export type PasswordOutcome =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "rate-limited" | "already-set" | "wrong-current" | "no-password" | "unavailable" };
