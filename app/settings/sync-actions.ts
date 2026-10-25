"use server";

import { revalidatePath } from "next/cache";
import { actionDenial } from "@/lib/auth/access";
import { StateSyncConfigurationError } from "@/lib/sync/config";
import { configuredStateSync } from "@/lib/sync/server";

export async function syncSharedState() {
  const denied = await actionDenial("owner"); if (denied) return denied;
  try {
    const result = await configuredStateSync(undefined, true);
    revalidatePath("/settings");
    if (result.state === "success") return { ok: true as const, message: "The saved shared snapshot is synced. Any newer changes remain pending below." };
    const error = result.state === "busy" ? "A sync is already running. Refresh its status shortly." :
      result.state === "conflict" ? "The private repository has conflicting shared changes. Nothing was overwritten. Ask the owner to reconcile the repository before retrying." :
        "The sync did not complete. Changes remain pending. Check the App configuration or connectivity, then retry.";
    return { ok: false as const, error };
  } catch (error) {
    console.error("Private state sync action failed.", { code: error instanceof StateSyncConfigurationError ? "not-configured" : "unavailable" });
    return { ok: false as const, error: error instanceof StateSyncConfigurationError ? error.message : "Sync is unavailable. Changes remain pending; try again." };
  }
}
