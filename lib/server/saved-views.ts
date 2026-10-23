import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";

export const VIEW_LISTS = ["recipes", "ingredients"] as const;
export type ViewList = (typeof VIEW_LISTS)[number];

/** Makes `query` the list's only default view. One transaction, so there is never zero or two defaults. */
export function setDefaultView(db: Db, list: ViewList, query: string): void {
  db.transaction((tx) => {
    tx.delete(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))).run();
    tx.insert(s.savedViews).values({ list, name: "Default", query, isDefault: true }).run();
  });
}

export function clearDefaultView(db: Db, list: ViewList): void {
  db.delete(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))).run();
}

export function defaultViewQuery(db: Db, list: string): string | null {
  return db.select({ query: s.savedViews.query }).from(s.savedViews).where(and(eq(s.savedViews.list, list), eq(s.savedViews.isDefault, true))).get()?.query ?? null;
}
