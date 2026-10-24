import { and, eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { getDb } from "./context";

/** Whether a profile with this id exists. The push routes use it before trusting an id from a request body. */
export async function personExists(personId: number): Promise<boolean> {
  const [row] = await (await getDb()).select({ id: s.people.id }).from(s.people).where(eq(s.people.id, personId)).limit(1);
  return Boolean(row);
}

/** An endpoint may be refreshed by its owner, never reassigned by another account. */
export async function savePushSubscription(personId: number, sub: { endpoint: string; p256dh: string; auth: string }): Promise<boolean> {
  const db = await getDb();
  const rows = await db.insert(s.pushSubscriptions).values({ personId, ...sub, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: s.pushSubscriptions.endpoint,
      set: { p256dh: sub.p256dh, auth: sub.auth },
      setWhere: eq(s.pushSubscriptions.personId, personId),
    }).returning({ id: s.pushSubscriptions.id });
  return rows.length === 1;
}

export async function hasPushSubscription(personId: number, endpoint: string): Promise<boolean> {
  const [row] = await (await getDb())
    .select({ id: s.pushSubscriptions.id })
    .from(s.pushSubscriptions)
    .where(and(eq(s.pushSubscriptions.personId, personId), eq(s.pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return Boolean(row);
}

export async function deletePushSubscription(endpoint: string, personId: number): Promise<void> {
  await (await getDb()).delete(s.pushSubscriptions).where(and(eq(s.pushSubscriptions.endpoint, endpoint), eq(s.pushSubscriptions.personId, personId)));
}
