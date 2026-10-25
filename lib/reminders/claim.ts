import type { Db } from "../db/client";
import * as s from "../db/schema";

/** Only the inserted person/day claim may proceed to provider I/O. */
export async function claimReminder(db: Db, reminder: typeof s.reminderLog.$inferInsert): Promise<boolean> {
  const [claim] = await db.insert(s.reminderLog).values(reminder).onConflictDoNothing()
    .returning({ personId: s.reminderLog.personId });
  return claim !== undefined;
}
