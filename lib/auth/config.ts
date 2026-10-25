import { z } from "zod";

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
  return {
    secret, baseURL: url.origin, bootstrapSecret: env.HOUSEHOLD_BOOTSTRAP_SECRET,
    isVercel: env.VERCEL === "1",
  };
}
