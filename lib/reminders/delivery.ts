import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { isReminderDue, localParts, type ReminderMessage } from "./due";
import { claimReminder } from "./claim";

type Registration = typeof s.pushSubscriptions.$inferSelect;
type Delivery = typeof s.reminderDeliveries.$inferSelect;
export type DeliveryOutcome = "accepted" | "gone" | "retry" | "ambiguous";

export async function reminderClock(db: Db): Promise<Date> {
  const [row] = await db.select({ now: sql<string>`clock_timestamp()::text` }).from(sql`(select 1) as reminder_clock`);
  return new Date(row!.now);
}

export function registrationFingerprint(sub: Pick<Registration, "endpoint" | "p256dh" | "auth">): string {
  return createHash("sha256").update(JSON.stringify([sub.endpoint, sub.p256dh, sub.auth])).digest("hex");
}

export async function expireDeliveryAttempts(db: Db): Promise<void> {
  await db.update(s.reminderDeliveries).set({ status: "ambiguous", updatedAt: sql`clock_timestamp()` }).where(and(
    eq(s.reminderDeliveries.status, "sending"), sql`${s.reminderDeliveries.attemptedAt} <= clock_timestamp() - interval '90 seconds'`,
  ));
}

async function eligible(db: Db, personId: number, now: Date, householdId: string): Promise<boolean> {
  const [member] = await db.select({ id: s.householdMembers.userId }).from(s.householdMembers)
    .innerJoin(s.people, and(eq(s.people.id, s.householdMembers.personId), eq(s.people.householdId, s.householdMembers.householdId)))
    .innerJoin(s.authUsers, and(eq(s.authUsers.id, s.householdMembers.userId), eq(s.authUsers.emailVerified, true)))
    .innerJoin(s.authSessions, and(eq(s.authSessions.userId, s.householdMembers.userId), gt(s.authSessions.expiresAt, now)))
    .where(and(eq(s.householdMembers.personId, personId), eq(s.householdMembers.householdId, householdId))).limit(1);
  return member !== undefined;
}

/** Freezes one day's message and devices only after all admission prerequisites exist. */
export async function prepareReminderBatch(db: Db, input: {
  personId: number; householdId: string; householdTimezone: string; payload: ReminderMessage | null; now: Date;
}): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const [person] = await tx.select().from(s.people).where(eq(s.people.id, input.personId)).for("update");
    if (!person || person.householdId !== input.householdId) return undefined;
    const zone = person.reminderTimezone ?? input.householdTimezone;
    if (!isReminderDue(person.reminderTime, input.now, zone, false)) return undefined;
    const { date, hhmm } = localParts(input.now, zone);
    const [batch] = await tx.select().from(s.reminderBatches)
      .where(and(eq(s.reminderBatches.personId, person.id), eq(s.reminderBatches.date, date)));
    if (batch) return batch.householdId === input.householdId ? batch.id : undefined;
    if (!input.payload) return undefined;
    const [legacy] = await tx.select().from(s.reminderLog)
      .where(and(eq(s.reminderLog.personId, person.id), eq(s.reminderLog.date, date)));
    const now = await reminderClock(tx);
    if (legacy || !await eligible(tx, person.id, now, input.householdId)) return undefined;
    const registrations = await tx.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.personId, person.id));
    if (registrations.length === 0) return undefined;
    const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const remainingSeconds = (31 - (toMinutes(hhmm) - toMinutes(person.reminderTime!))) * 60 - input.now.getUTCSeconds();
    const expiresAt = new Date(input.now.getTime() + remainingSeconds * 1000 - input.now.getUTCMilliseconds());
    if (expiresAt <= now) return undefined;
    const id = randomUUID();
    if (!await claimReminder(tx, { personId: person.id, date, sentAt: now.toISOString() })) return undefined;
    await tx.insert(s.reminderBatches).values({
      id, householdId: input.householdId, personId: person.id, date, payload: input.payload, createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await tx.insert(s.reminderDeliveries).values(registrations.map((sub) => ({
      batchId: id, subscriptionId: sub.id, fingerprint: registrationFingerprint(sub), updatedAt: now.toISOString(),
    })));
    return id;
  });
}

export interface DeliveryAttempt {
  batchId: string;
  subscriptionId: number;
  token: string;
  registration: Registration;
  payload: ReminderMessage;
}

/** A sending receipt is never reclaimed: a crashed worker may already have reached the provider. */
export async function claimDelivery(db: Db, batchId: string, subscriptionId: number): Promise<DeliveryAttempt | undefined> {
  return db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(s.reminderDeliveries)
      .where(and(eq(s.reminderDeliveries.batchId, batchId), eq(s.reminderDeliveries.subscriptionId, subscriptionId))).for("update");
    if (!receipt) return undefined;
    const now = await reminderClock(tx);
    const [batch] = await tx.select().from(s.reminderBatches).where(eq(s.reminderBatches.id, batchId));
    const key = and(eq(s.reminderDeliveries.batchId, batchId), eq(s.reminderDeliveries.subscriptionId, subscriptionId));
    if (receipt.status === "sending") {
      if (new Date(receipt.attemptedAt!).getTime() + 90_000 <= now.getTime()) {
        await tx.update(s.reminderDeliveries).set({ status: "ambiguous", updatedAt: now.toISOString() }).where(key);
      }
      return undefined;
    }
    if (!["pending", "retry"].includes(receipt.status)) return undefined;
    if (new Date(batch!.expiresAt) <= now || receipt.attempts >= 3) {
      await tx.update(s.reminderDeliveries).set({ status: "cancelled", updatedAt: now.toISOString() }).where(key);
      return undefined;
    }
    if (receipt.retryAt && new Date(receipt.retryAt) > now) return undefined;
    const [registration] = await tx.select().from(s.pushSubscriptions)
      .where(and(eq(s.pushSubscriptions.id, subscriptionId), eq(s.pushSubscriptions.personId, batch!.personId)));
    if (!registration || registrationFingerprint(registration) !== receipt.fingerprint || !batch!.householdId || !await eligible(tx, batch!.personId, now, batch!.householdId)) {
      await tx.update(s.reminderDeliveries).set({ status: "cancelled", updatedAt: now.toISOString() }).where(key);
      return undefined;
    }
    const token = randomUUID();
    await tx.update(s.reminderDeliveries).set({
      status: "sending", attempts: receipt.attempts + 1, attemptToken: token, attemptedAt: now.toISOString(),
      retryAt: null, updatedAt: now.toISOString(),
    }).where(key);
    return { batchId, subscriptionId, token, registration, payload: batch!.payload };
  });
}

export async function finishDelivery(db: Db, attempt: DeliveryAttempt, outcome: DeliveryOutcome): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(s.reminderDeliveries).where(and(
      eq(s.reminderDeliveries.batchId, attempt.batchId), eq(s.reminderDeliveries.subscriptionId, attempt.subscriptionId),
    )).for("update");
    if (!receipt || receipt.status !== "sending" || receipt.attemptToken !== attempt.token) return false;
    const now = await reminderClock(tx);
    const status: Delivery["status"] = outcome === "retry" && receipt.attempts >= 3 ? "cancelled" : outcome;
    await tx.update(s.reminderDeliveries).set({
      status, retryAt: status === "retry" ? new Date(now.getTime() + 60_000).toISOString() : null,
      updatedAt: now.toISOString(),
    }).where(and(eq(s.reminderDeliveries.batchId, attempt.batchId), eq(s.reminderDeliveries.subscriptionId, attempt.subscriptionId)));
    if (outcome === "gone") {
      const [current] = await tx.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.id, attempt.subscriptionId)).for("update");
      if (current && current.personId === attempt.registration.personId && registrationFingerprint(current) === receipt.fingerprint) {
        await tx.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.id, current.id));
      }
    }
    return true;
  });
}

export function deliveryFailure(error: unknown): DeliveryOutcome {
  const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status === 503) return "retry";
  return "ambiguous";
}
