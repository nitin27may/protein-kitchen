import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getAuth } from "./server";
import { HouseholdAccessError } from "./household";
import { AuthConfigurationError, authConfiguration } from "./config";
import { getDb } from "../server/context";
import { authUsers, householdMembers, people } from "../db/schema";

export class AccessDenied extends HouseholdAccessError {
  constructor(message: string, readonly status: 401 | 403 = 403) { super(message); }
}

export async function verifiedSessionUser(requestHeaders?: Headers) {
  const incoming = requestHeaders ?? await headers();
  const session = await (await getAuth()).api.getSession({ headers: incoming });
  if (!session) throw new AccessDenied("Sign in before continuing.", 401);
  if (!session.user.emailVerified) throw new AccessDenied("Verify your email before continuing.");
  return session.user;
}

export interface MemberAccess {
  userId: string;
  role: "owner" | "member";
  personId: number;
}

export async function requireMember(requestHeaders?: Headers): Promise<MemberAccess> {
  const user = await verifiedSessionUser(requestHeaders);
  const [member] = await (await getDb()).select({
    userId: householdMembers.userId, role: householdMembers.role, personId: people.id,
  }).from(householdMembers)
    .innerJoin(authUsers, and(eq(authUsers.id, householdMembers.userId), eq(authUsers.emailVerified, true)))
    .innerJoin(people, eq(people.id, householdMembers.personId))
    .where(eq(householdMembers.userId, user.id));
  if (!member) throw new AccessDenied("Finish household and profile onboarding before continuing.");
  return member;
}

export type AccessPolicy = "member" | "owner" | { personId: number };

export function checkPermission(member: MemberAccess, policy: AccessPolicy) {
  if (policy === "member" || member.role === "owner") return;
  if (policy === "owner") throw new AccessDenied("Only a household owner can do that.");
  if (!Number.isInteger(policy.personId) || member.personId !== policy.personId) {
    throw new AccessDenied("You can only change your own profile and routine choices.");
  }
}

export async function actionDenial(policy: AccessPolicy = "member") {
  try { checkPermission(await requireMember(), policy); return null; }
  catch (error) {
    if (error instanceof HouseholdAccessError) return { ok: false as const, error: error.message };
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Household access requires authentication configuration.");
    return { ok: false as const, error: "Authentication is not configured on this instance." };
  }
}

export async function requirePageMember(policy: AccessPolicy = "member") {
  let member: MemberAccess;
  try { member = await requireMember(); }
  catch (error) {
    if (error instanceof AccessDenied) redirect(error.status === 401 ? "/sign-in" : "/onboarding");
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Household page access requires authentication configuration.");
    redirect("/sign-in");
  }
  try { checkPermission(member, policy); }
  catch (error) {
    if (!(error instanceof AccessDenied)) throw error;
    redirect("/account");
  }
  return member;
}

export async function routeAccess(request: Request, mutation = false): Promise<
  { member: MemberAccess; response?: never } | { response: Response; member?: never }
> {
  try {
    if (mutation && request.headers.get("origin") !== authConfiguration(process.env).baseURL) {
      throw new AccessDenied("Requests must come from this application.");
    }
    return { member: await requireMember(request.headers) };
  } catch (error) {
    const status = error instanceof AccessDenied ? error.status : error instanceof AuthConfigurationError ? 503 : null;
    if (!status) throw error;
    if (status === 503) console.error("Household route access requires authentication configuration.");
    return { response: Response.json({ ok: false, error: error instanceof AccessDenied ? error.message : "Authentication is not configured on this instance." }, {
      status, headers: { "Cache-Control": "private, no-store" },
    }) };
  }
}
