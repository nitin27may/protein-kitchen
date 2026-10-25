import { APIError } from "better-auth/api";

/**
 * Signup is open and email-first: a user row may be created only by a proven six-digit code or a
 * consumed email link. Both provider endpoints create the user already verified. Password signup is disabled.
 */
export const USER_CREATION_PATHS: readonly string[] = ["/sign-in/email-otp", "/magic-link/verify"];

export function permitsUserCreation(path: string | undefined) {
  return path !== undefined && USER_CREATION_PATHS.includes(path);
}

/** Database-level backstop: refuses any user row that was not created by a proven email code or link. */
export function assertUserCreation(path: string | undefined, emailVerified: boolean | null | undefined) {
  if (!permitsUserCreation(path) || emailVerified !== true) {
    throw new APIError("FORBIDDEN", { message: "An account is created only by proving ownership of its email address." });
  }
}
