import { headers } from "next/headers";
import { AccessDenied, requireMember } from "./access";

/** Public requests without an auth cookie never initialize the database or mail provider. */
export async function optionalPageMember() {
  const incoming = await headers();
  const cookie = incoming.get("cookie") ?? "";
  if (!/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(cookie)) return null;
  try {
    return await requireMember(incoming);
  } catch (error) {
    if (error instanceof AccessDenied) return null;
    throw error;
  }
}

export type ShellAccount =
  | { kind: "visitor" }
  | { kind: "setup" }
  | { kind: "member"; member: Awaited<ReturnType<typeof requireMember>> };

/**
 * Account state for the app shell. A session without a finished profile (403) is "setup", not a visitor, so the shell
 * offers "Finish setting up" and "Sign out" instead of sign-up again. An expired session (401) is a visitor.
 */
export async function shellAccount(): Promise<ShellAccount> {
  const incoming = await headers();
  const cookie = incoming.get("cookie") ?? "";
  if (!/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(cookie)) return { kind: "visitor" };
  try {
    return { kind: "member", member: await requireMember(incoming) };
  } catch (error) {
    if (error instanceof AccessDenied) return { kind: error.status === 403 ? "setup" : "visitor" };
    throw error;
  }
}
