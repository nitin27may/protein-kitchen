import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { householdBootstrap, householdInvitations, householdMembers } from "../db/schema";
import { HouseholdAccessError } from "./household";
import { secretsMatch, tokenHash } from "./tokens";

/** Registration permits identity creation, not household membership; verified admission rechecks the grant. */
export async function authorizeSignup(db: Db, email: string, headers: Headers | undefined, bootstrapSecret: string | undefined) {
  const normalized = z.string().trim().toLowerCase().email().parse(email);
  const bootstrap = headers?.get("x-household-bootstrap");
  if (bootstrap && bootstrapSecret && bootstrapSecret.length >= 32 &&
      secretsMatch(bootstrap, bootstrapSecret)) {
    if (!(await db.select().from(householdBootstrap).limit(1)).length &&
        !(await db.select().from(householdMembers).limit(1)).length) return normalized;
  }
  const token = headers?.get("x-household-invitation");
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const [invitation] = await db.select({ id: householdInvitations.id }).from(householdInvitations).where(and(
      eq(householdInvitations.tokenHash, tokenHash(token)),
      eq(householdInvitations.email, normalized), isNull(householdInvitations.acceptedAt),
      isNull(householdInvitations.declinedAt),
      isNull(householdInvitations.revokedAt), gt(householdInvitations.expiresAt, new Date()),
    )).limit(1);
    if (invitation) return normalized;
  }
  throw new HouseholdAccessError("Signup requires a valid household invitation or the initial household claim key.");
}
