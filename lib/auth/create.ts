import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { emailOTP } from "better-auth/plugins";
import { ZodError } from "zod";
import { DrizzleQueryError, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { authorizeSignup } from "./signup";
import { HouseholdAccessError } from "./household";

export interface AuthCodeMail {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}

export interface AuthOptions {
  secret: string;
  baseURL: string;
  bootstrapSecret?: string;
  isVercel: boolean;
  sendCode: (mail: AuthCodeMail) => Promise<void>;
}

export function createAuth(db: Db, options: AuthOptions) {
  const delivery = new AsyncLocalStorage<{ failed: boolean }>();
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
      enabled: true, requireEmailVerification: true, autoSignIn: false,
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
        "/sign-up/email": { window: 60, max: 3 },
        "/sign-in/*": { window: 60, max: 5 },
        "/email-otp/*": { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.request?.method === "POST" && context.headers?.get("origin") !== options.baseURL) {
          throw new APIError("FORBIDDEN", { message: "Authentication requests must come from this application." });
        }
        if (context.path !== "/sign-up/email") return;
        if (typeof context.body?.email !== "string") throw new APIError("BAD_REQUEST", { message: "A valid signup email is required." });
        try {
          const email = await authorizeSignup(db, context.body.email, context.headers, options.bootstrapSecret);
          // Resolve admission before the adapter transaction, including on single-connection PGlite.
          return { context: { context: { householdSignupEmail: email } } };
        } catch (error) {
          if (error instanceof HouseholdAccessError) throw new APIError("FORBIDDEN", { message: error.message });
          if (error instanceof ZodError) throw new APIError("BAD_REQUEST", { message: "A valid signup email is required." });
          throw error;
        }
      }),
    },
    databaseHooks: {
      user: { create: { before: async (user, context) => {
        if (!context || !("householdSignupEmail" in context.context) ||
            context.context.householdSignupEmail !== user.email.trim().toLowerCase()) {
          throw new APIError("FORBIDDEN", { message: "Signup requires household admission." });
        }
        return { data: user };
      } } },
    },
    plugins: [emailOTP({
      disableSignUp: true, sendVerificationOnSignUp: true, overrideDefaultEmailVerification: true,
      otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: "hashed", resendStrategy: "rotate",
      async sendVerificationOTP(mail) {
        try {
          await options.sendCode(mail);
        } catch {
          const state = delivery.getStore();
          if (state) state.failed = true;
          console.error("Authentication code delivery failed.");
          throw new APIError("SERVICE_UNAVAILABLE", { message: "We could not send the email code. Please try again." });
        }
      },
    })],
  });
  return {
    // Session checks only; auth mutations go through HTTP so rate limits always run.
    api: { getSession: (input: { headers: Headers }) => auth.api.getSession(input) },
    handler(request: Request) {
      if (!isIP(request.headers.get(ipHeader) ?? "")) return Promise.resolve(Response.json({
        message: "A valid connecting address is required for authentication.",
      }, { status: 400, headers: { "Cache-Control": "private, no-store" } }));
      const state = { failed: false };
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
          message: "We could not send the email code. Please try again.",
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
