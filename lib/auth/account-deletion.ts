import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Db } from "../db/client";
import { deleteOwnAccount, HouseholdAccessError } from "./household";
import { EMAIL_CODE_LENGTH } from "./email-code";

const code = z.string().regex(new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`), "Enter the six-digit code from your email.");

/** Exactly one proof: a fresh email code, or the current password for an account that has one. */
const body = z.object({
  confirmation: z.literal("DELETE"),
  code: code.optional(),
  password: z.string().min(1).max(128).optional(),
}).strict().refine((value) => (value.code === undefined) !== (value.password === undefined), {
  message: "Send either an email code or your password.",
});

export interface AccountDeletionOptions {
  /** Called after the commit with the photo keys of a deleted household. Failures are logged, never shown with details. */
  deletePhotoKeys?: (keys: string[]) => Promise<void>;
}

export function accountDeletion(db: Db, options: AccountDeletionOptions = {}) {
  return {
    id: "household-account-deletion",
    endpoints: {
      deleteHouseholdAccount: createAuthEndpoint("/delete-household-account", {
        method: "POST",
        body,
        use: [sensitiveSessionMiddleware],
      }, async (ctx) => {
        ctx.setHeader("Cache-Control", "private, no-store");
        const identity = { userId: ctx.context.session.user.id, sessionToken: ctx.context.session.session.token };
        let photoKeys: string[];
        try {
          ({ photoKeys } = await deleteOwnAccount(db, ctx.body.code !== undefined
            ? { ...identity, code: ctx.body.code }
            : { ...identity, password: ctx.body.password!, verifyPassword: ctx.context.password.verify }));
        } catch (error) {
          if (error instanceof HouseholdAccessError) throw new APIError("FORBIDDEN", { message: error.message });
          throw error;
        }
        // The rows are gone, so a blob left behind is an orphan that `pnpm photos:check` reports. Never fail the request.
        if (photoKeys.length && options.deletePhotoKeys) {
          try { await options.deletePhotoKeys(photoKeys); }
          catch { console.error("Photo files of a deleted household could not all be removed."); }
        }
        deleteSessionCookie(ctx);
        return ctx.json({ success: true });
      }),
    },
  };
}
