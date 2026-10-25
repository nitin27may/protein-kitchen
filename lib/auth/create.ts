import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { emailOTP, magicLink } from "better-auth/plugins";
import { DrizzleQueryError, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { assertUserCreation } from "./signup";
import { accountDeletion } from "./account-deletion";
import { accountHasPassword, revokeOtherSessions, takePasswordAttempt, type PasswordOutcome } from "./password";

export interface AuthCodeMail {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}

export interface AuthLinkMail {
  email: string;
  url: string;
  type: "sign-in-link";
}

export interface AuthAssociationMail {
  email: string;
  url: string;
  type: "household-association";
}

export type AuthMail = AuthCodeMail | AuthLinkMail | AuthAssociationMail;

export interface AuthOptions {
  secret: string;
  baseURL: string;
  isVercel: boolean;
  sendCode: (mail: AuthCodeMail) => Promise<void>;
  sendLink: (mail: AuthLinkMail) => Promise<void>;
}

function passwordFailure(error: unknown): PasswordOutcome {
  if (error instanceof APIError) {
    const code = error.body?.code;
    if (code === "INVALID_PASSWORD") return { ok: false, reason: "wrong-current" };
    if (code === "PASSWORD_ALREADY_SET") return { ok: false, reason: "already-set" };
    if (error.status === "UNAUTHORIZED") return { ok: false, reason: "unauthenticated" };
  }
  // Never log the error object: provider errors can carry request context.
  console.error("Password change failed.");
  return { ok: false, reason: "unavailable" };
}

export function createAuth(db: Db, options: AuthOptions) {
  const delivery = new AsyncLocalStorage<{ failed: "code" | "link" | null }>();
  const linkCallback = "/onboarding";
  const linkErrorCallback = "/sign-in?emailLinkError=1";
  const ipHeader = options.isVercel ? "x-vercel-forwarded-for" : "x-forwarded-for";
  const auth = betterAuth({
    appName: "Protein Kitchen",
    baseURL: options.baseURL,
    secret: options.secret,
    logger: {
      level: "warn",
      log(level) {
        if (level === "error") console.error("Authentication provider reported an error.");
        else console.warn("Authentication provider reported a warning.");
      },
    },
    trustedOrigins: [options.baseURL],
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    user: { modelName: "authUsers" },
    session: { modelName: "authSessions", cookieCache: { enabled: false } },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    emailAndPassword: {
      enabled: true, disableSignUp: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true,
    },
    emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: false },
    advanced: {
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [ipHeader] },
    },
    rateLimit: {
      enabled: true, storage: "database", modelName: "authRateLimits", window: 60, max: 60,
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/email-otp/*": { window: 60, max: 5 },
        "/delete-household-account": { window: 60, max: 5 },
        "/verify-password": { window: 60, max: 5 },
        "/magic-link/verify": { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.request?.method === "POST" && context.headers?.get("origin") !== options.baseURL) {
          throw new APIError("FORBIDDEN", { message: "Authentication requests must come from this application." });
        }
        if (context.path === "/sign-in/magic-link" || context.path === "/magic-link/verify") {
          const input = context.path === "/sign-in/magic-link" ? context.body : context.query;
          if (input?.callbackURL !== linkCallback || input?.newUserCallbackURL !== linkCallback ||
              input?.errorCallbackURL !== linkErrorCallback) {
            throw new APIError("BAD_REQUEST", { message: "Email links must return to this application's onboarding flow." });
          }
        }
      }),
    },
    databaseHooks: {
      user: { create: { before: async (user, context) => {
        assertUserCreation(context?.path, user.emailVerified);
        return { data: user };
      } } },
    },
    plugins: [accountDeletion(db), magicLink({
      disableSignUp: false, expiresIn: 300, storeToken: "hashed",
      async sendMagicLink({ email, url, token }) {
        try {
          await options.sendLink({ email, url, type: "sign-in-link" });
        } catch {
          // Delivery only runs inside handler(), which always opens the store.
          delivery.getStore()!.failed = "link";
          console.error("Authentication link delivery failed.");
          const identifier = `magic-link:${createHash("sha256").update(token).digest("base64url")}`;
          await db.delete(schema.authVerifications).where(eq(schema.authVerifications.identifier, identifier));
          throw new APIError("SERVICE_UNAVAILABLE", { message: "We could not send the email link. Please try again." });
        }
      },
    }), emailOTP({
      disableSignUp: false, overrideDefaultEmailVerification: true,
      otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: "hashed", resendStrategy: "rotate",
      async sendVerificationOTP(mail) {
        try {
          await options.sendCode(mail);
        } catch {
          delivery.getStore()!.failed = "code";
          console.error("Authentication code delivery failed.");
          throw new APIError("SERVICE_UNAVAILABLE", { message: "We could not send the email code. Please try again." });
        }
      },
    })],
  });
  return {
    // Session checks only; auth mutations go through HTTP so rate limits always run.
    api: {
      getSession: (input: { headers: Headers }) => auth.api.getSession(input),
      /** Server-side only: Better Auth's setPassword has no HTTP route, so the limiter lives here. */
      async setPassword(input: { headers: Headers; newPassword: string }): Promise<PasswordOutcome> {
        const session = await auth.api.getSession({ headers: input.headers });
        if (!session?.user.emailVerified) return { ok: false, reason: "unauthenticated" };
        if (!await takePasswordAttempt(db, session.user.id)) return { ok: false, reason: "rate-limited" };
        if (await accountHasPassword(db, session.user.id)) return { ok: false, reason: "already-set" };
        try {
          await auth.api.setPassword({ headers: input.headers, body: { newPassword: input.newPassword } });
        } catch (error) {
          return passwordFailure(error);
        }
        await revokeOtherSessions(db, session.user.id, session.session.id);
        return { ok: true };
      },
      async changePassword(input: { headers: Headers; currentPassword: string; newPassword: string }): Promise<PasswordOutcome> {
        const session = await auth.api.getSession({ headers: input.headers });
        if (!session?.user.emailVerified) return { ok: false, reason: "unauthenticated" };
        if (!await takePasswordAttempt(db, session.user.id)) return { ok: false, reason: "rate-limited" };
        if (!await accountHasPassword(db, session.user.id)) return { ok: false, reason: "no-password" };
        try {
          // Other sessions are revoked below instead of by the provider, which would also end this one.
          await auth.api.changePassword({
            headers: input.headers, body: { currentPassword: input.currentPassword, newPassword: input.newPassword },
          });
        } catch (error) {
          return passwordFailure(error);
        }
        await revokeOtherSessions(db, session.user.id, session.session.id);
        return { ok: true };
      },
    },
    handler(request: Request) {
      if (!isIP(request.headers.get(ipHeader) ?? "")) return Promise.resolve(Response.json({
        message: "A valid connecting address is required for authentication.",
      }, { status: 400, headers: { "Cache-Control": "private, no-store" } }));
      const state: { failed: "code" | "link" | null } = { failed: null };
      return delivery.run(state, async () => {
        const path = new URL(request.url).pathname;
        const signingOut = request.method === "POST" && path === "/api/auth/sign-out";
        const resetting = request.method === "POST" && path === "/api/auth/email-otp/reset-password";
        const signingOutUser = signingOut ? (await auth.api.getSession({ headers: request.headers }))?.user.id : undefined;
        const resetBody: unknown = resetting ? await request.clone().json().catch(() => null) : null;
        let response: Response;
        try {
          response = await auth.handler(request);
        } catch (error) {
          if (!(error instanceof DrizzleQueryError)) throw error;
          console.error("Authentication database operation failed.");
          throw new Error("The authentication database is unavailable.");
        }
        // Better Auth awaits but catches mail errors internally, even without background tasks.
        if (state.failed) return Response.json({
          message: state.failed === "link" ? "We could not send the email link. Please try again." :
            "We could not send the email code. Please try again.",
        }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
        if ((signingOut || resetting) && response.ok) {
          const result: unknown = await response.clone().json();
          if (result && typeof result === "object" && "success" in result && result.success === true) {
            let userId = signingOutUser;
            if (resetting && resetBody && typeof resetBody === "object" && "email" in resetBody && typeof resetBody.email === "string") {
              const [user] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers)
                .where(eq(schema.authUsers.email, resetBody.email.trim().toLowerCase())).limit(1);
              userId = user?.id;
            }
            if (userId) {
              const profiles = db.select({ id: schema.householdMembers.personId }).from(schema.householdMembers)
                .where(eq(schema.householdMembers.userId, userId));
              await db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.personId, profiles));
            }
          }
        }
        return response;
      });
    },
  };
}
