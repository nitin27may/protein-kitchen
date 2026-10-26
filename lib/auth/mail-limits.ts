import { createHmac } from "node:crypto";
import { and, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { isAllowlisted, normaliseEmail, type SignupAllowlist } from "./allowlist";
import type { AuthMail } from "./create";

export const RECIPIENT_WINDOW_LIMIT = 3;
export const RECIPIENT_DAILY_LIMIT = 10;
const BLOCKED_PREFIX = "blocked:";

export class MailLimitError extends Error {
  override name = "MailLimitError";
}

export interface MailLimitOptions {
  /** BETTER_AUTH_SECRET: keys the recipient hash so a leaked table cannot be matched against address lists. */
  secret: string;
  dailyCap: number;
  allowlist: SignupAllowlist | null;
}

/** HMAC of the normalised address. The address itself is never stored. */
export function recipientHash(secret: string, email: string): string {
  return createHmac("sha256", secret).update(`mail-recipient:v1:${normaliseEmail(email)}`).digest("hex");
}

async function mayReceive(db: Db, options: MailLimitOptions, mail: AuthMail): Promise<boolean> {
  if (!options.allowlist || mail.type === "household-association") return true;
  const email = normaliseEmail(mail.email);
  if (isAllowlisted(options.allowlist, email)) return true;
  const [user] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers)
    .where(sql`lower(trim(${schema.authUsers.email})) = ${email}`).limit(1);
  if (user) return true;
  const [pending] = await db.select({ id: schema.householdInvitations.id }).from(schema.householdInvitations).where(and(
    sql`${schema.householdInvitations.email} = ${email}`, isNull(schema.householdInvitations.acceptedAt),
    isNull(schema.householdInvitations.declinedAt), isNull(schema.householdInvitations.revokedAt),
    gt(schema.householdInvitations.expiresAt, sql`now()`),
  )).limit(1);
  return Boolean(pending);
}

/**
 * Wraps an auth mail sender with per-recipient and global caps. The ledger row is written and the caps are checked in one
 * transaction under advisory locks, before the provider is called, so concurrent requests cannot both pass the last slot.
 *
 * Responses must not reveal whether an account exists. Every caller goes through the same cap checks and the same outcome
 * (return, or throw to give the existing generic delivery failure). An address that may not receive mail is recorded and
 * counted like any other, but the provider is not called.
 */
export function limitedSender(db: Db, options: MailLimitOptions, send: (mail: AuthMail) => Promise<void>) {
  return async (mail: AuthMail): Promise<void> => {
    const hash = recipientHash(options.secret, mail.email);
    const allowed = await mayReceive(db, options, mail);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${hash}))`);
      // Fixed lock order (recipient, then global) so two senders can never deadlock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mail-sends:global'))`);
      await tx.delete(schema.mailSends).where(lt(schema.mailSends.createdAt, sql`now() - interval '2 days'`));
      const dayStart = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;
      const [row] = await tx.select({
        recent: sql<number>`count(*) filter (where ${schema.mailSends.recipientHash} = ${hash} and ${schema.mailSends.createdAt} > now() - interval '15 minutes')::int`,
        today: sql<number>`count(*) filter (where ${schema.mailSends.recipientHash} = ${hash} and ${schema.mailSends.createdAt} >= ${dayStart})::int`,
        global: sql<number>`count(*) filter (where ${schema.mailSends.purpose} not like ${`${BLOCKED_PREFIX}%`} and ${schema.mailSends.createdAt} >= ${dayStart})::int`,
      }).from(schema.mailSends);
      if (!row || row.recent >= RECIPIENT_WINDOW_LIMIT || row.today >= RECIPIENT_DAILY_LIMIT || row.global >= options.dailyCap) {
        throw new MailLimitError("Authentication mail limit reached.");
      }
      await tx.insert(schema.mailSends).values({ recipientHash: hash, purpose: `${allowed ? "" : BLOCKED_PREFIX}${mail.type}` });
    });
    if (allowed) await send(mail);
  };
}
