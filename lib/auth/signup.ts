/**
 * Signup is open and email-first: a user row may be created only by a proven six-digit code or a
 * consumed email link. Both provider endpoints create the user already verified. Password signup is disabled.
 */
export const USER_CREATION_PATHS: readonly string[] = ["/sign-in/email-otp", "/magic-link/verify"];

export function permitsUserCreation(path: string | undefined) {
  return path !== undefined && USER_CREATION_PATHS.includes(path);
}
