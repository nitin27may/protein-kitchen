import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { clearSavedView, writeSavedView } from "../human/saved-views";

export const VIEW_LISTS = ["recipes", "ingredients"] as const;
export type ViewList = (typeof VIEW_LISTS)[number];

/** Makes `query` the list's only default view. Written through lib/human so the change is marked for export. */
export async function setDefaultView(db: Db, list: ViewList, query: string): Promise<void> {
  await writeSavedView(db, { list, query, name: "Default", isDefault: true });
}

export async function clearDefaultView(db: Db, list: ViewList): Promise<void> {
  await clearSavedView(db, list);
}

export async function defaultViewQuery(db: Db, list: string): Promise<string | null> {
  const [row] = await db.select({ query: s.savedViews.query }).from(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))).limit(1);
  return row?.query ?? null;
}
