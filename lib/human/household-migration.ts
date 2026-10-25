import { isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";

const legacyHouseholdId = "00000000-0000-4000-8000-000000000001";
const ownershipRoots = [
  s.people, s.householdInvitations, s.householdMembers, s.pantry, s.photoDecisions, s.photos,
  s.planSetups, s.plans, s.prepTaskState, s.recipeFeedback, s.recipeLinks, s.savedViews, s.stateSyncJobs, s.syncState,
];

/** Operator import only, called inside its exclusive empty-target transaction. Never merges household data. */
export async function bindImportedHousehold(db: Db): Promise<string | null> {
  return withTx(db, async (tx) => {
    if ((await tx.select({ id: s.households.id }).from(s.households).limit(1)).length) {
      throw new Error("Legacy ownership binding requires an unclaimed destination.");
    }
    let populated = false;
    for (const table of ownershipRoots) {
      if ((await tx.select({ householdId: table.householdId }).from(table).limit(1)).length) populated = true;
    }
    if (!populated) return null;
    await tx.insert(s.households).values({ id: legacyHouseholdId, name: "Existing household" });
    for (const table of ownershipRoots) {
      await tx.update(table).set({ householdId: legacyHouseholdId }).where(isNull(table.householdId));
    }
    return legacyHouseholdId;
  });
}
