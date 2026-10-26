import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../db/tx";
import * as s from "../db/schema";
import { HouseholdAccessError } from "../auth/household";
import { photoKeys } from "../photos/keys";
import { markChanged, nowIso } from "./util";
import type { ResetScope } from "../server/reset";

/** Caller holds the verified household lock; returned owned photo keys are cleaned only after commit. */
export async function clearHouseholdData(tx: Tx, householdId: string, scope: ResetScope): Promise<string[]> {
  const plans = await tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.householdId, householdId)).orderBy(s.plans.id).for("update");
  const profiles = await tx.select({ id: s.people.id }).from(s.people).where(eq(s.people.householdId, householdId)).orderBy(s.people.id).for("update");
  const planIds = plans.map((r) => r.id), personIds = profiles.map((r) => r.id);
  const slots = tx.select({ id: s.planSlots.id }).from(s.planSlots).where(inArray(s.planSlots.planId, planIds));
  const at = nowIso();
  const mark = (name: string) => markChanged(tx, name, at, householdId);

  async function clearPlans() {
    await tx.delete(s.planProgress).where(inArray(s.planProgress.planId, planIds));
    await tx.delete(s.planPartState).where(inArray(s.planPartState.planId, planIds));
    await tx.delete(s.planRoutines).where(inArray(s.planRoutines.planId, planIds));
    await tx.delete(s.planSlotPortions).where(inArray(s.planSlotPortions.planSlotId, slots));
    await tx.delete(s.groceryState).where(inArray(s.groceryState.planId, planIds));
    await tx.delete(s.groceryManual).where(inArray(s.groceryManual.planId, planIds));
    await tx.delete(s.planSlots).where(inArray(s.planSlots.planId, planIds));
    await tx.delete(s.plans).where(inArray(s.plans.id, planIds));
    await tx.delete(s.planSetups).where(eq(s.planSetups.householdId, householdId));
    await tx.delete(s.prepTaskState).where(eq(s.prepTaskState.householdId, householdId));
  }
  async function clearGroceries() {
    await tx.delete(s.groceryState).where(inArray(s.groceryState.planId, planIds));
    await tx.delete(s.groceryManual).where(inArray(s.groceryManual.planId, planIds));
    await tx.delete(s.pantry).where(eq(s.pantry.householdId, householdId));
  }
  async function clearProgress() {
    await tx.delete(s.habitLog).where(inArray(s.habitLog.personId, personIds));
    await tx.delete(s.reminderLog).where(inArray(s.reminderLog.personId, personIds));
    await tx.delete(s.prepTaskState).where(eq(s.prepTaskState.householdId, householdId));
  }
  async function clearPersonalFeedback() {
    await tx.delete(s.personRecipeFeedback).where(inArray(s.personRecipeFeedback.personId, personIds));
    await mark("personal-recipe-feedback");
  }
  async function clearRatings() {
    await clearPersonalFeedback();
    await tx.update(s.recipeFeedback).set({ status: "draft", rating: null, favourite: false, banned: false, notes: null, testedAt: null })
      .where(eq(s.recipeFeedback.householdId, householdId));
    await mark("recipe-feedback");
  }
  async function clearProfiles() {
    await clearPlans();
    const [portion] = await tx.select({ id: s.planSlotPortions.personId }).from(s.planSlotPortions).where(inArray(s.planSlotPortions.personId, personIds)).limit(1);
    const [routine] = await tx.select({ id: s.planRoutines.personId }).from(s.planRoutines).where(inArray(s.planRoutines.personId, personIds)).limit(1);
    const setups = await tx.select({ personIds: s.planSetups.personIds }).from(s.planSetups);
    if (portion || routine || setups.some((r) => r.personIds.some((id) => personIds.includes(id)))) {
      throw new HouseholdAccessError("Household reset refused: profiles have references outside this household.");
    }
    for (const table of [s.recipeFeedback, s.recipeLinks, s.savedViews, s.photos, s.photoDecisions]) {
      const [foreign] = await tx.select({ id: table.createdByPersonId }).from(table)
        .where(and(inArray(table.createdByPersonId, personIds), sql`${table.householdId} is distinct from ${householdId}`)).limit(1);
      if (foreign) throw new HouseholdAccessError("Household reset refused: profiles have references outside this household.");
    }
    for (const table of [s.personRecipeFeedback, s.personRoutines]) {
      const [foreign] = await tx.select({ id: table.personId }).from(table)
        .where(and(inArray(table.createdByPersonId, personIds), notInArray(table.personId, personIds))).limit(1);
      if (foreign) throw new HouseholdAccessError("Household reset refused: profiles have references outside this household.");
    }
    const [batch] = await tx.select({ id: s.reminderBatches.id }).from(s.reminderBatches)
      .where(and(inArray(s.reminderBatches.personId, personIds), sql`${s.reminderBatches.householdId} is distinct from ${householdId}`)).limit(1);
    if (batch) throw new HouseholdAccessError("Household reset refused: profiles have references outside this household.");
    await clearProgress();
    await tx.delete(s.pushSubscriptions).where(inArray(s.pushSubscriptions.personId, personIds));
    await tx.delete(s.preferences).where(inArray(s.preferences.personId, personIds));
    await tx.delete(s.personRoutines).where(inArray(s.personRoutines.personId, personIds));
    await mark("person-routines");
    await clearPersonalFeedback();
    await tx.delete(s.people).where(inArray(s.people.id, personIds));
  }

  switch (scope) {
    case "plans": await clearPlans(); break;
    case "groceries": await clearGroceries(); break;
    case "progress": await clearProgress(); break;
    case "ratings": await clearRatings(); break;
    case "profiles": await clearProfiles(); break;
    case "all": {
      const photos = await tx.select({ uid: s.photos.uid }).from(s.photos).where(eq(s.photos.householdId, householdId));
      await clearProfiles();
      await clearGroceries();
      await clearRatings();
      await tx.delete(s.savedViews).where(eq(s.savedViews.householdId, householdId));
      await mark("saved-views");
      await tx.delete(s.recipeLinks).where(eq(s.recipeLinks.householdId, householdId));
      await mark("recipe-links");
      await tx.delete(s.photos).where(eq(s.photos.householdId, householdId));
      await mark("photos");
      await tx.delete(s.photoDecisions).where(eq(s.photoDecisions.householdId, householdId));
      await mark("photo-decisions");
      return photos.flatMap(({ uid }) => Object.values(photoKeys(uid)));
    }
  }
  return [];
}

/**
 * Removes a whole household for good: access, invitations, every profile and everything hanging off it, then the
 * household row. Used when the last member deletes their account. The caller holds the deployment lock and runs this in
 * one transaction. Returns the photo blob keys, which the caller deletes only after the commit.
 *
 * The generic test in tests/account-deletion.test.ts walks every table with a household_id column, so a table added
 * later fails there until it is cleared here.
 */
export async function deleteHousehold(tx: Tx, householdId: string): Promise<string[]> {
  // Membership and invitation rows point at profiles, so they go first.
  await tx.delete(s.householdInvitations).where(eq(s.householdInvitations.householdId, householdId));
  await tx.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
  const photoKeysToDelete = await clearHouseholdData(tx, householdId, "all");
  await tx.delete(s.reminderBatches).where(eq(s.reminderBatches.householdId, householdId));
  await tx.delete(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, householdId));
  await tx.delete(s.stateSyncJobs).where(eq(s.stateSyncJobs.householdId, householdId));
  // clearHouseholdData marks data classes as changed; the household is going, so those rows go too.
  await tx.delete(s.syncState).where(eq(s.syncState.householdId, householdId));
  await tx.delete(s.households).where(eq(s.households.id, householdId));
  return photoKeysToDelete;
}
