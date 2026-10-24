import { and, eq, gt } from "drizzle-orm";
import webpush from "web-push";
import * as s from "@/lib/db/schema";
import { buildReminder, isReminderDue, localParts } from "@/lib/reminders/due";
import { claimDelivery, deliveryFailure, expireDeliveryAttempts, finishDelivery, prepareReminderBatch, reminderClock, type DeliveryOutcome } from "@/lib/reminders/delivery";
import { getData, getDb } from "./context";
import { householdReminderTasks, reminderPeople } from "@/lib/reminders/context";
import { APP_TZ } from "./time";
import { sendPush } from "@/lib/reminders/transport";

export function vapidConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function configure(): boolean {
  if (!vapidConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return true;
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** Sends one notification to every device a person has registered. Dead subscriptions are removed. */
export async function sendToPerson(personId: number, payload: { title: string; body: string; url: string }): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (!configure()) return result;
  const db = await getDb();
  const [member] = await db.select({ id: s.householdMembers.userId }).from(s.householdMembers)
    .innerJoin(s.people, and(eq(s.people.id, s.householdMembers.personId), eq(s.people.householdId, s.householdMembers.householdId)))
    .innerJoin(s.authUsers, and(eq(s.authUsers.id, s.householdMembers.userId), eq(s.authUsers.emailVerified, true)))
    .innerJoin(s.authSessions, and(eq(s.authSessions.userId, s.householdMembers.userId), gt(s.authSessions.expiresAt, new Date())))
    .where(eq(s.householdMembers.personId, personId)).limit(1);
  if (!member) return result;
  const subs = await db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.personId, personId));
  for (const sub of subs) {
    try {
      await sendPush(sub, payload);
      result.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.id, sub.id));
        result.removed++;
      } else {
        result.failed++;
      }
    }
  }
  return result;
}

/** Scheduled sends use frozen device receipts; manual test pushes remain separate. */
export async function dispatchReminders(at?: Date) {
  const result = { sent: 0, retry: 0, ambiguous: 0, cancelled: 0 };
  if (!vapidConfigured()) return result;
  const db = await getDb();
  const databaseNow = await reminderClock(db);
  const now = at ?? databaseNow;
  await expireDeliveryAttempts(db);
  const { date: householdDate } = localParts(now, APP_TZ);
  const tasksByHousehold = new Map<string, string[]>();
  for (const { person: p } of await reminderPeople(db, databaseNow)) {
    if (!isReminderDue(p.reminderTime, now, p.reminderTimezone ?? APP_TZ, false)) continue;
    const householdId = p.householdId!;
    let open = tasksByHousehold.get(householdId);
    if (!open) {
      open = await householdReminderTasks(db, getData(), householdId, householdDate);
      tasksByHousehold.set(householdId, open);
    }
    const msg = buildReminder(p.name, open);
    const batchId = await prepareReminderBatch(db, { personId: p.id, householdId, householdTimezone: APP_TZ, payload: msg, now });
    if (!batchId) continue;
    const devices = await db.select({ id: s.reminderDeliveries.subscriptionId }).from(s.reminderDeliveries)
      .where(eq(s.reminderDeliveries.batchId, batchId));
    for (const device of devices) {
      if (!configure()) throw new Error("Reminder provider configuration changed during scheduling.");
      const attempt = await claimDelivery(db, batchId, device.id);
      if (!attempt) continue;
      let outcome: DeliveryOutcome = "accepted";
      try {
        await sendPush(attempt.registration, attempt.payload);
      } catch (error) {
        outcome = deliveryFailure(error);
      }
      if (await finishDelivery(db, attempt, outcome) && outcome === "accepted") result.sent++;
    }
    const outcomes = await db.select({ status: s.reminderDeliveries.status }).from(s.reminderDeliveries).where(eq(s.reminderDeliveries.batchId, batchId));
    for (const { status } of outcomes) if (status === "retry" || status === "ambiguous" || status === "cancelled") result[status]++;
  }
  return result;
}
