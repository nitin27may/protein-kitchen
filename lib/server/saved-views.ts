import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { clearSavedView, writeSavedView } from "../human/saved-views";
import { withTx } from "../db/tx";
import { refreshHouseholdAccess, requireHouseholdProfile, type HouseholdAccess } from "../auth/household-access";

export const VIEW_LISTS = ["recipes", "ingredients"] as const;
export type ViewList = (typeof VIEW_LISTS)[number];

/** Makes `query` the list's only default view. Written through lib/human so the change is marked for export. */
export async function setDefaultView(db: Db, list: ViewList, query: string): Promise<void> {
  await writeSavedView(db, { list, query, name: "Default", isDefault: true });
}

export async function clearDefaultView(db: Db, list: ViewList): Promise<void> {
  await clearSavedView(db, list);
}

export async function changeHouseholdDefaultView(db: Db, access: HouseholdAccess, list: ViewList, query: string | null): Promise<void> {
  await withTx(db, async (tx) => {
    await refreshHouseholdAccess(tx, access);
    const personId = requireHouseholdProfile(access);
    await tx.select({ id: s.households.id }).from(s.households)
      .where(eq(s.households.id, access.householdId)).for("update");
    if (query === null) await clearSavedView(tx, list, access.householdId);
    else await writeSavedView(tx, { householdId: access.householdId, list, query, name: "Default", isDefault: true, createdByPersonId: personId });
  });
}

export async function defaultViewQuery(db: Db, list: string, householdId?: string): Promise<string | null> {
  const [row] = await db.select({ query: s.savedViews.query }).from(s.savedViews).where(and(
    householdId === undefined ? isNull(s.savedViews.householdId) : eq(s.savedViews.householdId, householdId),
    eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true),
  )).limit(1);
  return row?.query ?? null;
}
