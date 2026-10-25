"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { Result } from "@/app/actions";
import { verifiedSessionIdentity } from "@/lib/auth/access";
import { AuthConfigurationError } from "@/lib/auth/config";
import { HouseholdAccessError, renameHousehold as renameOwnedHousehold } from "@/lib/auth/household";
import { getDb } from "@/lib/server/context";

export async function renameHousehold(householdId: string, name: string): Promise<Result<{ name: string }>> {
  try {
    const identity = await verifiedSessionIdentity();
    const renamed = await renameOwnedHousehold(await getDb(), identity.userId, householdId, name);
    revalidatePath("/", "layout");
    return { ok: true, name: renamed.name };
  } catch (error) {
    if (error instanceof HouseholdAccessError) return { ok: false, error: error.message };
    if (error instanceof ZodError) return { ok: false, error: error.issues[0]?.message ?? "Check the household name and try again." };
    if (error instanceof AuthConfigurationError) {
      console.error("Household rename requires authentication configuration.");
      return { ok: false, error: "Authentication is not configured on this instance." };
    }
    throw error;
  }
}
