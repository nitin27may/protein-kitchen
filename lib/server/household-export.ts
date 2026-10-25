import type { Db } from "../db/client";
import { refreshHouseholdAccess, requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";
import { exportHumanData } from "../human/export";

/** Shared files only; target binding and transport belong to the caller, never to the client. */
export async function exportHouseholdState(db: Db, access: HouseholdAccess, classes: readonly string[]) {
  return db.transaction(async (tx) => {
    await refreshHouseholdAccess(tx, access);
    requireHouseholdProfile(access);
    return exportHumanData(tx, classes, { householdId: access.householdId });
  }, { isolationLevel: "repeatable read" });
}
