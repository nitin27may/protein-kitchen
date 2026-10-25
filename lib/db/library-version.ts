import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DataSet } from "../data/load";
import { stableJson } from "../human/util";
import type { Db } from "./client";
import { libraryState } from "./schema";

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

export async function verifyLibraryVersion(db: Db, data: DataSet): Promise<void> {
  const [version] = await db.select().from(libraryState).where(eq(libraryState.key, "library"));
  if (version?.version !== libraryVersion(data)) {
    throw new Error("Database library is missing or out of date. Run the guarded migration and seed commands before starting the app.");
  }
}
