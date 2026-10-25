import { sql } from "drizzle-orm";
import type { Tx } from "../db/tx";
import { households } from "../db/schema";

/** The legacy file format has no household namespace; caller retains this lock through all class work. */
export async function checkLegacyBundleTarget(tx: Tx, operation: "export" | "import"): Promise<void> {
  await tx.execute(sql`lock table ${households} in share mode`);
  const rows = await tx.select({ id: households.id }).from(households).limit(2);
  if (operation === "import" && rows.length) {
    throw new Error("Legacy human-data import requires an unclaimed operator staging database; household import is not supported.");
  }
  if (operation === "export" && rows.length > 1) {
    throw new Error("Legacy human-data export cannot represent multiple households. Use a verified household export or encrypted whole-instance backup.");
  }
}
