import type { Db } from "../db/client";
import type { HouseholdAccess } from "../auth/household-access";
import { HouseholdAccessError } from "../auth/household";
import type { BlobStore } from "../blob/types";
import { clearHouseholdData } from "../human/reset";
import { mutateHouseholdState } from "./household-plans";
import type { ResetScope } from "./reset";

export class ResetPhotoCleanupError extends Error {
  constructor() { super("The household reset committed, but some photo bytes could not be removed. Ask the operator to run photos:check."); }
}

/** The backup gate is the caller's prerequisite; this service never authorizes or creates a backup. */
export async function resetHouseholdData(db: Db, access: HouseholdAccess, scope: ResetScope, store?: BlobStore) {
  const keys = await mutateHouseholdState(db, access, async (tx) => {
    if (access.role !== "owner") throw new HouseholdAccessError("Only a household owner can reset household data.");
    if (scope === "all" && !store) throw new Error("Household photo storage is required for an Everything reset.");
    return clearHouseholdData(tx, access.householdId, scope);
  });
  if (store) {
    const results = await Promise.allSettled(keys.map((key) => store.delete(key)));
    if (results.some((r) => r.status === "rejected")) throw new ResetPhotoCleanupError();
  }
}
