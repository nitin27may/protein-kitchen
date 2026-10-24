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
