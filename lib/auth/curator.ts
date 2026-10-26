import { eq } from "drizzle-orm";
import { actionDenial, requireMember, type MemberAccess } from "./access";
import { normaliseEmail } from "./allowlist";
import { AuthConfigurationError } from "./config";
import { parseCuratorEmails } from "./curator-list";
import { photoWritesEnabled } from "../blob/config";
import { authUsers } from "../db/schema";
import { photoReviewEnabled, PHOTO_REVIEW_DISABLED_MESSAGE } from "../photos/review-flag";
import { getDb } from "../server/context";

export { parseCuratorEmails, MAX_CURATORS } from "./curator-list";

export const CURATOR_DENIED_MESSAGE = "Only photo curators can do that.";

/**
 * Whether this member may approve LIBRARY photos: a verified account whose address is in PHOTO_CURATOR_EMAILS.
 * Unset, blank or malformed configuration means nobody. The address is read from the auth user, never from input.
 */
export async function isCurator(member: Pick<MemberAccess, "userId">, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  let curators: ReadonlySet<string>;
  try { curators = parseCuratorEmails(env.PHOTO_CURATOR_EMAILS); }
  catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Photo curator configuration is invalid; no curators are recognised.");
    return false;
  }
  if (curators.size === 0) return false;
  const [user] = await (await getDb()).select({ email: authUsers.email, verified: authUsers.emailVerified })
    .from(authUsers).where(eq(authUsers.id, member.userId)).limit(1);
  return !!user && user.verified && curators.has(normaliseEmail(user.email));
}

/** Gate for every curator action. Order is fixed: member/rate checks, review window, writes allowed, curator. */
export async function curatorDenial() {
  const denied = await actionDenial();
  if (denied) return denied;
  if (!photoReviewEnabled()) return { ok: false as const, error: PHOTO_REVIEW_DISABLED_MESSAGE };
  if (!photoWritesEnabled()) return { ok: false as const, error: "Photo changes are disabled in preview deployments." };
  if (!(await isCurator(await requireMember()))) return { ok: false as const, error: CURATOR_DENIED_MESSAGE };
  return null;
}
