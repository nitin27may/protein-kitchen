import { headers } from "next/headers";

/**
 * True when the request carries a session cookie, valid or not. It never touches the database. A household page uses it
 * to show the anonymous prompt only to visitors with no session at all: a signed-in person who has lost access goes
 * through the membership guard and is sent to sign in or to onboarding.
 */
export async function hasSessionCookie(): Promise<boolean> {
  const cookie = (await headers()).get("cookie") ?? "";
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(cookie);
}
