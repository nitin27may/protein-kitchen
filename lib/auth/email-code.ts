import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Tx } from "../db/tx";
import { authVerifications } from "../db/schema";
import { secretsMatch } from "./tokens";

/** Shared with the email-OTP plugin configuration so both sides agree on lifetime and attempts. */
export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_SECONDS = 300;
export const EMAIL_CODE_ATTEMPTS = 3;

/** The plugin's `hashed` storage: SHA-256 of the code, base64url without padding. */
const hashCode = (code: string) => createHash("sha256").update(code).digest("base64url");

export type CodeCheck = { ok: true } | { ok: false; message: string };

const refusal = "That code is not valid. Request a new code and try again.";

/**
 * Checks and consumes the account-deletion code for one address inside the caller's transaction. The code is the
 * plugin's `email-verification` code, so it can only exist for an address a code was mailed to (through the mail caps),
 * and it is looked up by the session user's own email, never by anything the browser submits.
 *
 * The row is locked, so concurrent attempts are serialised and a code works once. A wrong guess burns an attempt and an
 * exhausted or expired row is deleted. The caller must commit these writes before it reports a refusal, so they are
 * returned as data instead of thrown.
 */
export async function consumeEmailCode(tx: Tx, email: string, code: string, now = new Date()): Promise<CodeCheck> {
  const identifier = `email-verification-otp-${email.trim().toLowerCase()}`;
  const [row] = await tx.select().from(authVerifications).where(eq(authVerifications.identifier, identifier)).for("update");
  if (!row) return { ok: false, message: refusal };
  const split = row.value.lastIndexOf(":");
  const stored = split === -1 ? row.value : row.value.slice(0, split);
  const attempts = split === -1 ? 0 : Number(row.value.slice(split + 1));
  if (row.expiresAt.getTime() <= now.getTime() || !Number.isInteger(attempts) || attempts >= EMAIL_CODE_ATTEMPTS) {
    await tx.delete(authVerifications).where(eq(authVerifications.id, row.id));
    return { ok: false, message: refusal };
  }
  if (!/^\d+$/.test(code) || !secretsMatch(hashCode(code), stored)) {
    await tx.update(authVerifications).set({ value: `${stored}:${attempts + 1}` }).where(eq(authVerifications.id, row.id));
    return { ok: false, message: refusal };
  }
  await tx.delete(authVerifications).where(eq(authVerifications.id, row.id));
  return { ok: true };
}
