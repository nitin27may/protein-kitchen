import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { DataSet } from "../data/load";
import { stableJson } from "../human/util";
import type { Db } from "./client";
import { libraryState, libraryVersions } from "./schema";

/** How many of the most recently seeded versions a running build may still serve. */
export const LIBRARY_COMPATIBILITY_WINDOW = 10;

/** Includes content changes even when row counts are unchanged. */
export function libraryVersion(data: DataSet): string {
  return createHash("sha256").update(stableJson({
    ingredients: Object.fromEntries(data.ingredients),
    recipes: Object.fromEntries(data.recipes),
    techniques: Object.fromEntries(data.techniques),
    habits: data.habits,
    micros: data.micros,
    renames: data.renames,
  })).digest("hex");
}

export type LibraryStatus = "exact" | "compatible" | "stale";

/** Classifies this build's library against the database: exact, within the last-N window, or stale (also when unseeded). */
export async function libraryStatus(db: Db, data: DataSet): Promise<LibraryStatus> {
  const own = libraryVersion(data);
  const [current] = await db.select().from(libraryState).where(eq(libraryState.key, "library"));
  if (current?.version === own) return "exact";
  if (!current) return "stale";
  const recent = await db.select({ version: libraryVersions.version }).from(libraryVersions)
    .orderBy(desc(libraryVersions.seededAt), desc(libraryVersions.version)).limit(LIBRARY_COMPATIBILITY_WINDOW);
  return recent.some((row) => row.version === own) ? "compatible" : "stale";
}

/**
 * Accepts the exact current version, or this build's own version while it is among the last
 * LIBRARY_COMPATIBILITY_WINDOW seeded versions. The seed only adds and updates library rows, so an older build
 * keeps working after a newer seed and Vercel instant rollback can cold-start. Deployment checks stay exact.
 */
export async function verifyLibraryVersion(db: Db, data: DataSet): Promise<void> {
  const status = await libraryStatus(db, data);
  if (status === "exact") return;
  if (status === "compatible") {
    console.warn("Database library is newer than this build; serving within the compatibility window.");
    return;
  }
  throw new Error("Database library is missing or out of date. Run the guarded migration and seed commands before starting the app.");
}
