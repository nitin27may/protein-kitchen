"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import type { Result } from "@/app/actions";
import { getDb } from "@/lib/server/context";
import { checkPermission, requireMember, verifiedSessionIdentity, verifiedSessionUser } from "@/lib/auth/access";
import { AuthConfigurationError } from "@/lib/auth/config";
import { acceptEmailAssociation, acceptInvitation, addEmailAssociation as createEmailAssociation, assignMemberProfile, changeMemberRole, claimHousehold, createMemberProfile, declineEmailAssociation, emailAssociationRecipient, HouseholdAccessError, issueInvitation, removeHouseholdMember, revokeInvitation } from "@/lib/auth/household";
import type { PersonInputData } from "@/lib/schemas/person";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { createSessionHousehold, resolveSessionHouseholdAccess, selectSessionHousehold } from "@/lib/auth/household-session";
import { sendHouseholdAssociationNotice } from "@/lib/auth/server";

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

export async function createHousehold(name: string): Promise<Result<{ householdId: string }>> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const created = await createSessionHousehold(await getDb(), identity, name);
    return { householdId: created.householdId };
  });
}

export async function finishProfile(input: PersonInputData): Promise<Result<{ id: number }>> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    return createMemberProfile(db, identity.userId, input, access);
  });
}

export async function linkOwnProfile(personId: number): Promise<Result> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    await assignMemberProfile(db, identity.userId, identity.userId, personId, access);
    return {};
  });
}

export async function inviteCook(email: string, personId?: number): Promise<Result<{ token: string; email: string }>> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    const invitation = await issueInvitation(db, identity.userId, { email, personId }, access);
    return { token: invitation.token, email: invitation.email };
  });
}

export async function addHouseholdEmailAssociation(input: {
  email: string; displayName?: string; relationship?: string;
}): Promise<Result<{ id: string; emailSent: boolean }>> {
  const result = await attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    return createEmailAssociation(db, identity.userId, input, access);
  });
  if (!result.ok) return result;
  try {
    await sendHouseholdAssociationNotice(result.email);
    return { ok: true, id: result.id, emailSent: true };
  } catch {
    console.error("Household association email delivery failed.");
    revalidatePath("/", "layout");
    return { ok: true, id: result.id, emailSent: false };
  }
}

export async function resendHouseholdAssociationNotice(id: string): Promise<Result> {
  const result = await attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    return { email: await emailAssociationRecipient(db, identity.userId, id, access) };
  });
  if (!result.ok) return result;
  try {
    await sendHouseholdAssociationNotice(result.email);
    return { ok: true };
  } catch {
    console.error("Household association email delivery failed.");
    return { ok: false, error: "The email could not be sent. Try again." };
  }
}

export async function acceptHouseholdEmailAssociation(id: string): Promise<Result> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    await acceptEmailAssociation(await getDb(), identity, id);
    return {};
  });
}

export async function declineHouseholdEmailAssociation(id: string): Promise<Result> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    await declineEmailAssociation(await getDb(), identity, id);
    return {};
  });
}

export async function cancelInvitation(id: string): Promise<Result> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const db = await getDb();
    const access = await resolveSessionHouseholdAccess(db, identity);
    await revokeInvitation(db, identity.userId, id, access);
    return {};
  });
}

export async function changeCookRole(userId: string, role: "owner" | "member"): Promise<Result> {
  return attempt(async () => {
    const actor = await requireMember();
    checkPermission(actor, "owner");
    const db = await getDb();
    await changeMemberRole(db, actor.userId, userId, role, await memberHouseholdAccess(db, actor));
    return {};
  });
}

export async function removeCook(userId: string): Promise<Result> {
  return attempt(async () => {
    const actor = await requireMember();
    checkPermission(actor, "owner");
    const db = await getDb();
    await removeHouseholdMember(db, actor.userId, userId, await memberHouseholdAccess(db, actor));
    return {};
  });
}

export async function chooseHousehold(householdId: string): Promise<Result<{ householdId: string; profileComplete: boolean }>> {
  return attempt(async () => {
    const identity = await verifiedSessionIdentity();
    const selected = z.string().trim().min(1).max(128).parse(householdId);
    return selectSessionHousehold(await getDb(), identity, selected);
  });
}
