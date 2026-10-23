import { and, eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { getDb } from "./context";

/** Whether a profile with this id exists. The push routes use it before trusting an id from a request body. */
export async function personExists(personId: number): Promise<boolean> {
  const [row] = await (await getDb()).select({ id: s.people.id }).from(s.people).where(eq(s.people.id, personId)).limit(1);
  return Boolean(row);
}

/** Registers a device. An existing registration for the same endpoint is replaced, so re-enabling never duplicates. */
export async function savePushSubscription(personId: number, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
  const db = await getDb();
  await db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, sub.endpoint));
  await db.insert(s.pushSubscriptions).values({ personId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, createdAt: new Date().toISOString() });
}

export async function hasPushSubscription(personId: number, endpoint: string): Promise<boolean> {
  const [row] = await (await getDb())
    .select({ id: s.pushSubscriptions.id })
    .from(s.pushSubscriptions)
    .where(and(eq(s.pushSubscriptions.personId, personId), eq(s.pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return Boolean(row);
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await (await getDb()).delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint));
}
