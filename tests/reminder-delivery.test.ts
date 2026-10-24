import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDelivery, deliveryFailure, expireDeliveryAttempts, finishDelivery, prepareReminderBatch, registrationFingerprint, reminderClock,
} from "../lib/reminders/delivery";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
const now = new Date("2099-10-24T21:00:00.000Z");
const payload = { title: "Synthetic reminder", body: "Synthetic prep", url: "/" };
const input = () => ({ personId: 1, householdTimezone: "UTC", payload, now });
const key = (batchId: string, subscriptionId = 1) =>
  and(eq(s.reminderDeliveries.batchId, batchId), eq(s.reminderDeliveries.subscriptionId, subscriptionId));
async function device(id = 1) {
  await h.db.insert(s.pushSubscriptions).values({
    id, personId: 1, endpoint: `https://push.example.test/${id}`, p256dh: `synthetic-${id}`, auth: "synthetic",
    createdAt: now.toISOString(),
  });
}
async function batch() { return (await prepareReminderBatch(h.db, input()))!; }
async function receipt(batchId: string, subscriptionId = 1) {
  return (await h.db.select().from(s.reminderDeliveries).where(key(batchId, subscriptionId)))[0]!;
}
async function allowRetry(batchId: string) {
  await h.db.update(s.reminderDeliveries).set({ retryAt: "2000-01-01T00:00:00Z" }).where(key(batchId));
}
beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.people).values({
    id: 1, name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "light", dietFlags: [], reminderTime: "21:00",
  });
  await h.db.insert(s.authUsers).values({ id: "user", name: "Synthetic cook", email: "receipt@example.test", emailVerified: true });
  await h.db.insert(s.householdMembers).values({ userId: "user", personId: 1, role: "owner" });
  await h.db.insert(s.authSessions).values({
    id: "session", token: "synthetic-receipt-session", userId: "user",
    expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(),
  });
  await device();
});

describe("durable daily reminder batches", () => {
  it("uses the database clock and atomically freezes one batch and device set across concurrent callers", async () => {
    expect(Math.abs((await reminderClock(h.db)).getTime() - Date.now())).toBeLessThan(10_000);
    const ids = await Promise.all(Array.from({ length: 8 }, batch));
    expect(new Set(ids).size).toBe(1);
    expect(await h.db.select().from(s.reminderBatches)).toHaveLength(1);
    expect(await h.db.select().from(s.reminderLog)).toHaveLength(1);
    await device(2);
    expect(await prepareReminderBatch(h.db, { ...input(), payload: { ...payload, body: "changed" } })).toBe(ids[0]);
    expect(await h.db.select().from(s.reminderDeliveries)).toHaveLength(1);
    expect((await h.db.select().from(s.reminderBatches))[0]!.payload).toEqual(payload);
    const json = JSON.stringify(await h.db.select().from(s.reminderDeliveries));
    expect(json).not.toContain("https://");
    expect(json).not.toContain("synthetic");
  });
  it("does not burn the day without tasks or devices, allowing later admission", async () => {
    expect(await prepareReminderBatch(h.db, { ...input(), payload: null })).toBeUndefined();
    await h.db.delete(s.pushSubscriptions);
    expect(await prepareReminderBatch(h.db, input())).toBeUndefined();
    expect(await h.db.select().from(s.reminderLog)).toEqual([]);
    await device();
    expect(await batch()).toBeTruthy();
  });
  it.each(["unverified", "expired", "revoked"])("does not admit an %s identity", async (change) => {
    if (change === "unverified") await h.db.update(s.authUsers).set({ emailVerified: false });
    if (change === "expired") await h.db.update(s.authSessions).set({ expiresAt: new Date(0) });
    if (change === "revoked") await h.db.delete(s.householdMembers);
    expect(await prepareReminderBatch(h.db, input())).toBeUndefined();
    expect(await h.db.select().from(s.reminderLog)).toEqual([]);
  });
  it("preserves legacy claims and refuses missing profiles or times outside the window", async () => {
    expect(await prepareReminderBatch(h.db, { ...input(), personId: 999 })).toBeUndefined();
    expect(await prepareReminderBatch(h.db, { ...input(), now: new Date("2099-10-24T20:59:00Z") })).toBeUndefined();
    await h.db.insert(s.reminderLog).values({ personId: 1, date: "2099-10-24", sentAt: now.toISOString() });
    expect(await prepareReminderBatch(h.db, input())).toBeUndefined();
    expect(await h.db.select().from(s.reminderBatches)).toEqual([]);
  });
  it("uses a cook's timezone for the batch date and bounds the remaining send window", async () => {
    await h.db.update(s.people).set({ reminderTimezone: "Pacific/Auckland", reminderTime: "10:00" });
    const id = await batch();
    const [saved] = await h.db.select().from(s.reminderBatches).where(eq(s.reminderBatches.id, id));
    expect(saved!.date).toBe("2099-10-25");
    expect(new Date(saved!.expiresAt).getTime() - now.getTime()).toBe(31 * 60_000);
  });
  it("refuses a stale admission snapshot rather than extending its original window", async () => {
    expect(await prepareReminderBatch(h.db, { ...input(), now: new Date("2000-01-01T21:00:00Z") })).toBeUndefined();
    expect(await h.db.select().from(s.reminderLog)).toEqual([]);
  });
  it("rolls back the daily claim if device receipt persistence fails", async () => {
    await h.failWrite("reminder_deliveries", "INSERT", "receipt_failure");
    await expect(batch()).rejects.toThrow();
    expect(await h.db.select().from(s.reminderLog)).toEqual([]);
    expect(await h.db.select().from(s.reminderBatches)).toEqual([]);
    await h.dropFailure("reminder_deliveries", "receipt_failure");
    expect(await batch()).toBeTruthy();
  });
  it("never creates a batch if the daily admission insert does not return a winner", async () => {
    await h.client.exec(`CREATE FUNCTION refuse_reminder_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER refuse_reminder_claim BEFORE INSERT ON reminder_log FOR EACH ROW EXECUTE FUNCTION refuse_reminder_claim();`);
    expect(await prepareReminderBatch(h.db, input())).toBeUndefined();
    expect(await h.db.select().from(s.reminderBatches)).toEqual([]);
  });
});

describe("fenced device attempts and explicit outcomes", () => {
  it("admits one concurrent provider attempt and never replays an accepted device", async () => {
    const id = await batch();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => claimDelivery(h.db, id, 1)));
    const winners = attempts.filter((v) => v !== undefined);
    expect(winners).toHaveLength(1);
    const attempt = winners[0]!;
    expect(await finishDelivery(h.db, { ...attempt, token: randomUUID() }, "accepted")).toBe(false);
    expect(await finishDelivery(h.db, attempt, "accepted")).toBe(true);
    expect(await finishDelivery(h.db, attempt, "retry")).toBe(false);
    expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
    expect(await receipt(id)).toMatchObject({ status: "accepted", attempts: 1, retryAt: null });
  });
  it("retries only rejected devices after delay, never successful devices, up to three attempts", async () => {
    await device(2);
    const id = await batch();
    await finishDelivery(h.db, (await claimDelivery(h.db, id, 2))!, "accepted");
    for (let index = 0; index < 3; index++) {
      const attempt = (await claimDelivery(h.db, id, 1))!;
      expect(attempt).toBeDefined();
      await finishDelivery(h.db, attempt, "retry");
      expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
      await allowRetry(id);
    }
    expect(await receipt(id)).toMatchObject({ status: "cancelled", attempts: 3 });
    expect(await receipt(id, 2)).toMatchObject({ status: "accepted", attempts: 1 });
  });
  it.each(["expired-window", "limit", "removed", "replacement", "owner-change", "revoked", "session-expired", "unverified"])(
    "cancels a pending device on %s", async (change) => {
      const id = await batch();
      if (change === "expired-window") await h.db.update(s.reminderBatches).set({ expiresAt: "2000-01-01T00:00:00Z" });
      if (change === "limit") await h.db.update(s.reminderDeliveries).set({ attempts: 3 });
      if (change === "removed") await h.db.delete(s.pushSubscriptions);
      if (change === "replacement") await h.db.update(s.pushSubscriptions).set({ auth: "replacement" });
      if (change === "owner-change") {
        await h.db.insert(s.people).values({ id: 2, name: "Other", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] });
        await h.db.update(s.pushSubscriptions).set({ personId: 2 });
      }
      if (change === "revoked") await h.db.delete(s.householdMembers);
      if (change === "session-expired") await h.db.update(s.authSessions).set({ expiresAt: new Date(0) });
      if (change === "unverified") await h.db.update(s.authUsers).set({ emailVerified: false });
      expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
      expect(await receipt(id)).toMatchObject({ status: "cancelled", attempts: change === "limit" ? 3 : 0 });
    },
  );
  it("turns interrupted sending into ambiguity, refuses the late worker and never replays", async () => {
    const id = await batch();
    const attempt = (await claimDelivery(h.db, id, 1))!;
    expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
    await h.db.update(s.reminderDeliveries).set({ attemptedAt: "2000-01-01T00:00:00Z" });
    expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
    expect(await receipt(id)).toMatchObject({ status: "ambiguous", attempts: 1 });
    expect(await finishDelivery(h.db, attempt, "accepted")).toBe(false);
    expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
  });
  it("records uncertain transport outcomes without blindly retrying", async () => {
    const id = await batch();
    await finishDelivery(h.db, (await claimDelivery(h.db, id, 1))!, "ambiguous");
    expect(await claimDelivery(h.db, id, 1)).toBeUndefined();
    expect(await receipt(id)).toMatchObject({ status: "ambiguous" });
  });
  it("expires abandoned attempts from earlier local days without touching active or accepted devices", async () => {
    await device(2);
    const id = await batch();
    await claimDelivery(h.db, id, 1);
    await finishDelivery(h.db, (await claimDelivery(h.db, id, 2))!, "accepted");
    await expireDeliveryAttempts(h.db);
    expect(await receipt(id)).toMatchObject({ status: "sending" });
    await h.db.update(s.reminderDeliveries).set({ attemptedAt: "2000-01-01T00:00:00Z" }).where(key(id));
    await expireDeliveryAttempts(h.db);
    expect(await receipt(id)).toMatchObject({ status: "ambiguous", attempts: 1 });
    expect(await receipt(id, 2)).toMatchObject({ status: "accepted" });
  });
  it.each(["unchanged", "replaced", "removed", "owner-change"])("removes a dead registration only when %s", async (change) => {
    const id = await batch();
    const attempt = (await claimDelivery(h.db, id, 1))!;
    if (change === "replaced") await h.db.update(s.pushSubscriptions).set({ p256dh: "replacement" });
    if (change === "removed") await h.db.delete(s.pushSubscriptions);
    if (change === "owner-change") {
      await h.db.insert(s.people).values({ id: 2, name: "Other", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] });
      await h.db.update(s.pushSubscriptions).set({ personId: 2 });
    }
    expect(await finishDelivery(h.db, attempt, "gone")).toBe(true);
    expect(await h.db.select().from(s.pushSubscriptions)).toHaveLength(["unchanged", "removed"].includes(change) ? 0 : 1);
    expect(await receipt(id)).toMatchObject({ status: "gone" });
  });
  it("refuses missing receipts, preserves state on failed acknowledgement and supports an exact-token retry", async () => {
    expect(await claimDelivery(h.db, randomUUID(), 999)).toBeUndefined();
    const id = await batch();
    const attempt = (await claimDelivery(h.db, id, 1))!;
    expect(await finishDelivery(h.db, { ...attempt, subscriptionId: 999 }, "accepted")).toBe(false);
    await h.failWrite("reminder_deliveries", "UPDATE", "outcome_failure");
    await expect(finishDelivery(h.db, attempt, "accepted")).rejects.toThrow();
    await h.dropFailure("reminder_deliveries", "outcome_failure");
    expect(await receipt(id)).toMatchObject({ status: "sending" });
    expect(await finishDelivery(h.db, attempt, "accepted")).toBe(true);
  });
  it("rolls back admission when the attempt write fails before external I/O", async () => {
    const id = await batch();
    await h.failWrite("reminder_deliveries", "UPDATE", "attempt_failure");
    await expect(claimDelivery(h.db, id, 1)).rejects.toThrow();
    expect(await receipt(id)).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("enforces receipt statuses and attempt limits in the database", async () => {
    const id = await batch();
    await expect(h.db.execute(sql`update reminder_deliveries set status = 'unrecognised' where batch_id = ${id}`)).rejects.toThrow();
    await expect(h.db.update(s.reminderDeliveries).set({ attempts: 4 })).rejects.toThrow();
  });
});

describe("safe provider outcome classification", () => {
  it.each([404, 410])("marks %s gone", (statusCode) => expect(deliveryFailure({ statusCode })).toBe("gone"));
  it.each([429, 503])("allows a bounded retry after explicit %s rejection", (statusCode) => expect(deliveryFailure({ statusCode })).toBe("retry"));
  it.each([undefined, null, "private failure", {}, new Error("private error"), { statusCode: 500 }, { statusCode: 401 }, { statusCode: "429" }])(
    "treats an unknown failure as ambiguous", (error) => expect(deliveryFailure(error)).toBe("ambiguous"),
  );
  it("fingerprints all registration keys unambiguously", () => {
    const original = { endpoint: "a", p256dh: "b", auth: "c" };
    expect(registrationFingerprint(original)).toMatch(/^[a-f0-9]{64}$/);
    expect(registrationFingerprint(original)).not.toBe(registrationFingerprint({ ...original, auth: "d" }));
    expect(registrationFingerprint(original)).not.toBe(registrationFingerprint({ endpoint: "ab", p256dh: "", auth: "c" }));
  });
});
