import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Db } from "../db/client";
import { deleteOwnAccount, HouseholdAccessError } from "./household";

export function accountDeletion(db: Db) {
  return {
    id: "household-account-deletion",
    endpoints: {
      deleteHouseholdAccount: createAuthEndpoint("/delete-household-account", {
        method: "POST",
        body: z.object({ password: z.string().min(1).max(128), confirmation: z.literal("DELETE") }).strict(),
        use: [sensitiveSessionMiddleware],
      }, async (ctx) => {
        ctx.setHeader("Cache-Control", "private, no-store");
        try {
          await deleteOwnAccount(db, {
            userId: ctx.context.session.user.id, sessionToken: ctx.context.session.session.token,
            password: ctx.body.password, verifyPassword: ctx.context.password.verify,
          });
        } catch (error) {
          if (error instanceof HouseholdAccessError) throw new APIError("FORBIDDEN", { message: error.message });
          throw error;
        }
        deleteSessionCookie(ctx);
        return ctx.json({ success: true });
      }),
    },
  };
}
