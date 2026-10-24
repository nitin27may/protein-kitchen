import { and, eq, gt } from "drizzle-orm";
import webpush from "web-push";
import * as s from "@/lib/db/schema";
import { buildReminder, isReminderDue, localParts } from "@/lib/reminders/due";
import { claimDelivery, deliveryFailure, expireDeliveryAttempts, finishDelivery, prepareReminderBatch, reminderClock, type DeliveryOutcome } from "@/lib/reminders/delivery";
import { getDb } from "./context";
import { loadNight, tonight } from "./prep";
import { getPlanView, latestPlanId, listPeople } from "./queries";
import { APP_TZ } from "./time";

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
    .innerJoin(s.authUsers, and(eq(s.authUsers.id, s.householdMembers.userId), eq(s.authUsers.emailVerified, true)))
    .innerJoin(s.authSessions, and(eq(s.authSessions.userId, s.householdMembers.userId), gt(s.authSessions.expiresAt, new Date())))
    .where(eq(s.householdMembers.personId, personId)).limit(1);
  if (!member) return result;
  const subs = await db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.personId, personId));
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 6 });
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
export async function checkReminders(at?: Date): Promise<number> {
  if (!vapidConfigured()) return 0;
  const db = await getDb();
  const now = at ?? await reminderClock(db);
  await expireDeliveryAttempts(db);
  const { date: householdDate } = localParts(now, APP_TZ);
  const planId = await latestPlanId();
  const view = planId ? await getPlanView(planId) : undefined;
  const night = view ? await loadNight(view, householdDate) : undefined;
  let sent = 0;
  for (const p of await listPeople()) {
    if (!isReminderDue(p.reminderTime, now, p.reminderTimezone ?? APP_TZ, false)) continue;
    const open = tonight(night, householdDate).filter((t) => !t.done).map((t) => `${t.text}, for ${t.forName}`);
    const msg = buildReminder(p.name, open);
    const batchId = await prepareReminderBatch(db, { personId: p.id, householdTimezone: APP_TZ, payload: msg, now });
    if (!batchId) continue;
    const devices = await db.select({ id: s.reminderDeliveries.subscriptionId }).from(s.reminderDeliveries)
      .where(eq(s.reminderDeliveries.batchId, batchId));
    for (const device of devices) {
      if (!configure()) return sent;
      const attempt = await claimDelivery(db, batchId, device.id);
      if (!attempt) continue;
      let outcome: DeliveryOutcome = "accepted";
      try {
        const sub = attempt.registration;
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(attempt.payload), { TTL: 60 * 60 * 6, timeout: 10_000 });
      } catch (error) {
        outcome = deliveryFailure(error);
      }
      if (await finishDelivery(db, attempt, outcome) && outcome === "accepted") sent++;
    }
  }
  return sent;
}
