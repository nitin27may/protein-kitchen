import { headers } from "next/headers";
import { getAuth } from "./server";
import { HouseholdAccessError } from "./household";

export async function verifiedSessionUser() {
  const session = await (await getAuth()).api.getSession({ headers: await headers() });
  if (!session) throw new HouseholdAccessError("Sign in before continuing.");
  if (!session.user.emailVerified) throw new HouseholdAccessError("Verify your email before continuing.");
  return session.user;
}
