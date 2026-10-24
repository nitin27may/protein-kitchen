import { and, count as countRows, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { withTx } from "../db/tx";
import type { Tx } from "../db/tx";
import { markChanged, nowIso } from "../human/util";
import { resetPersonalFeedback } from "../human/personal-feedback";

export const RESET_SCOPES = ["plans", "groceries", "progress", "ratings", "profiles", "all"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

/** Scopes that wipe people. They need the typed word, not just a click. */
export const NEEDS_TYPED_CONFIRM: readonly ResetScope[] = ["profiles", "all"];
export const CONFIRM_WORD = "RESET";

export interface ResetCounts {
  profiles: number;
  plans: number;
  groceryItems: number;
  progressTicks: number;
  ratings: number;
  /** Make, buy or have choices saved on plans. They go with the plans. */
  partChoices: number;
  /** Saved recipe and video links. Only "Everything" clears them: they are yours, like ratings. */
  links: number;
  /** Routine choices people made (methi water, soaked almonds). They are tied to a profile, so deleting profiles or "Everything" clears them. */
  routineChoices: number;
  /** What plans copied from those choices. They go with the plans. */
  planRoutines: number;
  /** Next-steps ticks (review, shop, prep) saved on plans. They go with the plans. */
  planSteps: number;
  /** Your own and approved photos, with their approvals. Only "Everything" clears them: they are yours, like ratings. */
  photos: number;
}

// Drizzle's count() is a bigint on Postgres, so every result goes through Number().
async function count(db: Db, table: PgTable, where?: SQL): Promise<number> {
  const [row] = await db.select({ n: countRows() }).from(table).where(where);
  return Number(row?.n ?? 0);
}

export async function resetCounts(db: Db, householdId?: string): Promise<ResetCounts> {
  const owned = (column: AnyPgColumn<{ data: string }>) => householdId === undefined ? undefined : eq(column, householdId);
  const people = db.select({ id: s.people.id }).from(s.people).where(owned(s.people.householdId));
  const plans = db.select({ id: s.plans.id }).from(s.plans).where(owned(s.plans.householdId));
  const person = (column: AnyPgColumn<{ data: number }>) => householdId === undefined ? undefined : inArray(column, people);
  const plan = (column: AnyPgColumn<{ data: number }>) => householdId === undefined ? undefined : inArray(column, plans);
  const [feedback] = await db
    .select({ n: countRows() })
    .from(s.recipeFeedback)
    .where(and(owned(s.recipeFeedback.householdId), or(isNotNull(s.recipeFeedback.rating), eq(s.recipeFeedback.favourite, true), eq(s.recipeFeedback.banned, true), eq(s.recipeFeedback.status, "tested"), isNotNull(s.recipeFeedback.notes))));
  return {
    profiles: await count(db, s.people, owned(s.people.householdId)),
    plans: await count(db, s.plans, owned(s.plans.householdId)),
    groceryItems: (await count(db, s.groceryState, plan(s.groceryState.planId))) + (await count(db, s.groceryManual, plan(s.groceryManual.planId))) + (await count(db, s.pantry, owned(s.pantry.householdId))),
    progressTicks: (await count(db, s.habitLog, person(s.habitLog.personId))) + (await count(db, s.prepTaskState, owned(s.prepTaskState.householdId))),
    ratings: Number(feedback?.n ?? 0) + await count(db, s.personRecipeFeedback, person(s.personRecipeFeedback.personId)),
    partChoices: await count(db, s.planPartState, plan(s.planPartState.planId)),
    links: await count(db, s.recipeLinks, owned(s.recipeLinks.householdId)),
    routineChoices: await count(db, s.personRoutines, person(s.personRoutines.personId)),
    planRoutines: await count(db, s.planRoutines, and(plan(s.planRoutines.planId), person(s.planRoutines.personId))),
    planSteps: await count(db, s.planProgress, plan(s.planProgress.planId)),
    photos: await count(db, s.photos, owned(s.photos.householdId)),
  };
}

async function clearPlans(tx: Tx) {
  await tx.delete(s.planProgress);
  await tx.delete(s.planPartState);
  await tx.delete(s.planRoutines);
  await tx.delete(s.planSlotPortions);
  await tx.delete(s.groceryState);
  await tx.delete(s.groceryManual);
  await tx.delete(s.planSlots);
  await tx.delete(s.plans);
  await tx.delete(s.planSetups);
  await tx.delete(s.prepTaskState);
}

async function clearGroceries(tx: Tx) {
  await tx.delete(s.groceryState);
  await tx.delete(s.groceryManual);
  await tx.delete(s.pantry);
}

async function clearProgress(tx: Tx) {
  await tx.delete(s.habitLog);
  await tx.delete(s.reminderLog);
  await tx.delete(s.prepTaskState);
}

async function clearRatings(tx: Tx) {
  await resetPersonalFeedback(tx);
  await tx.update(s.recipeFeedback).set({ status: "draft", rating: null, favourite: false, banned: false, notes: null, testedAt: null });
  await markChanged(tx, "recipe-feedback", nowIso());
}

async function clearProfiles(tx: Tx) {
  await clearPlans(tx);
  await clearProgress(tx);
  await tx.delete(s.pushSubscriptions);
  await tx.delete(s.preferences);
  // Routine choices belong to a profile; deleting the people deletes them (the foreign key cascades), so mark the export.
  await tx.delete(s.personRoutines);
  await markChanged(tx, "person-routines", nowIso());
  await resetPersonalFeedback(tx);
  await tx.delete(s.people);
}

/**
 * Deletes user data only. Recipes, ingredients, techniques and habits come from /data and are never touched.
 * Runs in one transaction, so a failure leaves everything as it was.
 */
export async function resetData(db: Db, scope: ResetScope, photoStore?: BlobStore): Promise<void> {
  await withTx(db, async (tx) => {
    switch (scope) {
      case "plans": return await clearPlans(tx);
      case "groceries": return await clearGroceries(tx);
      case "progress": return await clearProgress(tx);
      case "ratings": return await clearRatings(tx);
      case "profiles": return await clearProfiles(tx);
      case "all":
        await clearProfiles(tx);
        await clearGroceries(tx);
        await clearRatings(tx);
        await tx.delete(s.savedViews);
        await markChanged(tx, "saved-views", nowIso());
        await tx.delete(s.recipeLinks);
        await markChanged(tx, "recipe-links", nowIso());
        await tx.delete(s.photos);
        await markChanged(tx, "photos", nowIso());
        await tx.delete(s.photoDecisions);
        await markChanged(tx, "photo-decisions", nowIso());
        return;
    }
  });
  // Photo bytes are outside the transaction. The rows are gone, so any blob left is an orphan; the backup holds a copy.
  if (scope === "all" && photoStore) for (const key of await photoStore.list()) await photoStore.delete(key);
}

/** Destructive application resets stay disabled until the Postgres backup/restore gate is implemented. */
export async function backupBeforeReset(): Promise<string> {
  throw new Error("Reset is disabled: a verified Postgres backup and restore procedure is required first.");
}
