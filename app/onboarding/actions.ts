"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import type { Result } from "@/app/actions";
import { getDb } from "@/lib/server/context";
import { checkPermission, requireMember, verifiedSessionUser } from "@/lib/auth/access";
import { AuthConfigurationError } from "@/lib/auth/config";
import { acceptInvitation, assignMemberProfile, changeMemberRole, claimHousehold, createMemberProfile, HouseholdAccessError, issueInvitation, removeHouseholdMember, revokeInvitation } from "@/lib/auth/household";
import type { PersonInputData } from "@/lib/schemas/person";

async function attempt<T extends object>(task: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await task();
    revalidatePath("/", "layout");
    return { ok: true, ...value };
  } catch (error) {
    if (error instanceof HouseholdAccessError) return { ok: false, error: error.message };
    if (error instanceof AuthConfigurationError) {
      console.error("Account access requires authentication configuration.");
      return { ok: false, error: "Authentication is not configured on this instance." };
    }
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
      return { ok: false, error: "Check the marked fields and try again.", fields };
    }
    throw error;
  }
}

export async function joinHousehold(kind: "bootstrap" | "invitation", grant: string): Promise<Result> {
  return attempt(async () => {
    const user = await verifiedSessionUser();
    z.string().min(1, "Enter your household key or invitation code.").max(256).parse(grant);
    const db = await getDb();
    if (kind === "bootstrap") {
      if (!process.env.HOUSEHOLD_BOOTSTRAP_SECRET) throw new HouseholdAccessError("Initial household setup is not available on this instance.");
      await claimHousehold(db, user.id, grant, process.env.HOUSEHOLD_BOOTSTRAP_SECRET);
    } else if (kind === "invitation") await acceptInvitation(db, user.id, grant);
    else throw new HouseholdAccessError("Choose how you are joining the household.");
    return {};
  });
}

export async function finishProfile(input: PersonInputData): Promise<Result<{ id: number }>> {
  return attempt(async () => {
    const user = await verifiedSessionUser();
    return createMemberProfile(await getDb(), user.id, input);
  });
}

export async function linkOwnProfile(personId: number): Promise<Result> {
  return attempt(async () => {
    const user = await verifiedSessionUser();
    await assignMemberProfile(await getDb(), user.id, user.id, personId);
    return {};
  });
}

export async function inviteCook(email: string, personId?: number): Promise<Result<{ token: string; email: string }>> {
  return attempt(async () => {
    const user = await verifiedSessionUser();
    const invitation = await issueInvitation(await getDb(), user.id, { email, personId });
    return { token: invitation.token, email: invitation.email };
  });
}

export async function cancelInvitation(id: string): Promise<Result> {
  return attempt(async () => {
    const user = await verifiedSessionUser();
    await revokeInvitation(await getDb(), user.id, id);
    return {};
  });
}

export async function changeCookRole(userId: string, role: "owner" | "member"): Promise<Result> {
  return attempt(async () => {
    const actor = await requireMember();
    checkPermission(actor, "owner");
    await changeMemberRole(await getDb(), actor.userId, userId, role);
    return {};
  });
}

export async function removeCook(userId: string): Promise<Result> {
  return attempt(async () => {
    const actor = await requireMember();
    checkPermission(actor, "owner");
    await removeHouseholdMember(await getDb(), actor.userId, userId);
    return {};
  });
}
