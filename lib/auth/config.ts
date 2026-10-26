import { z } from "zod";
import { mailDailyCap, parseSignupAllowlist } from "./allowlist";

export class AuthConfigurationError extends Error {
  override name = "AuthConfigurationError";
}

export function authConfiguration(env: Readonly<Record<string, string | undefined>>) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new AuthConfigurationError("BETTER_AUTH_SECRET must contain at least 32 characters.");
  const parsed = z.string().url().safeParse(env.BETTER_AUTH_URL);
  if (!parsed.success) throw new AuthConfigurationError("BETTER_AUTH_URL must name the fixed application origin.");
  const url = new URL(parsed.data);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local && !env.VERCEL && env.NODE_ENV !== "production"))) {
    throw new AuthConfigurationError("BETTER_AUTH_URL must be an HTTPS origin (HTTP loopback is local development only).");
  }
  if (env.HOUSEHOLD_BOOTSTRAP_SECRET && env.HOUSEHOLD_BOOTSTRAP_SECRET.length < 32) {
    throw new AuthConfigurationError("HOUSEHOLD_BOOTSTRAP_SECRET must contain at least 32 characters, or be removed after claiming.");
  }
  const ownerEmail = householdOwnerEmail(env);
  return {
    secret, baseURL: url.origin, bootstrapSecret: env.HOUSEHOLD_BOOTSTRAP_SECRET, ownerEmail,
    isVercel: env.VERCEL === "1",
    mailDailyCap: mailDailyCap(env), signupAllowlist: parseSignupAllowlist(env.SIGNUP_ALLOWLIST),
  };
}

/** Server-only. The value is never logged or echoed, including in configuration errors. */
export function householdOwnerEmail(env: Readonly<Record<string, string | undefined>>) {
  const raw = env.HOUSEHOLD_OWNER_EMAIL?.trim();
  if (!raw) return undefined;
  // The owner-email claim path is kept for local and e2e flows only; production must not carry it.
  if (env.VERCEL_ENV === "production") throw new AuthConfigurationError("HOUSEHOLD_OWNER_EMAIL must not be set in production.");
  const parsed = z.string().email().max(254).safeParse(raw);
  if (!parsed.success) throw new AuthConfigurationError("HOUSEHOLD_OWNER_EMAIL must be a valid email address.");
  return parsed.data.toLowerCase();
}
