import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";
import { manualItemExists, planExists, slotBelongsToPlan } from "../lib/server/plan-access";
import { deletePushSubscription, hasPushSubscription, personExists, savePushSubscription } from "../lib/server/subscriptions";
import { getDb } from "../lib/server/context";
import { sendToPerson } from "../lib/server/push";
import webpush from "web-push";
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
let h: DbHandle;
let personId: number;
let planId: number;
let slotId: number;
beforeAll(async () => { h = await openDb(); });
beforeEach(async () => {
  vi.mocked(getDb).mockResolvedValue(h.db);
  await h.db.insert(s.households).values({ id: "fixture", name: "Synthetic household" });
  const [p] = await h.db.insert(s.people).values({
    householdId: "fixture",
    name: "Synthetic object fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  personId = p!.id;
  const [setup] = await h.db.insert(s.planSetups).values({
    personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"], cuisineBalance: 0.5,
    maxActiveMin: null, createdAt: new Date().toISOString(),
  }).returning({ id: s.planSetups.id });
  const [plan] = await h.db.insert(s.plans).values({ setupId: setup!.id, seed: 1, createdAt: new Date().toISOString() }).returning({ id: s.plans.id });
  planId = plan!.id;
  const [recipe] = await h.db.insert(s.recipes).values({
    slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  }).returning({ id: s.recipes.id });
  const [slot] = await h.db.insert(s.planSlots).values({ planId, date: "2026-11-02", slot: "dinner", recipeId: recipe!.id, locked: false }).returning({ id: s.planSlots.id });
  slotId = slot!.id;
  await h.db.insert(s.planSlotPortions).values({ planSlotId: slotId, personId, servings: 1 });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });
describe("plan child consistency", () => {
  it("refuses invalid or nonexistent ids, mismatched plans and unallocated people", async () => {
    expect(await planExists(h.db, planId)).toBe(true);
    expect(await planExists(h.db, planId + 1)).toBe(false);
    for (const id of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await planExists(h.db, id)).toBe(false);
      expect(await slotBelongsToPlan(h.db, id, slotId)).toBe(false);
      expect(await slotBelongsToPlan(h.db, planId, id)).toBe(false);
      expect(await slotBelongsToPlan(h.db, planId, slotId, id)).toBe(false);
      expect(await manualItemExists(h.db, id)).toBe(false);
    }
    expect(await slotBelongsToPlan(h.db, planId, slotId)).toBe(true);
    expect(await slotBelongsToPlan(h.db, planId + 1, slotId)).toBe(false);
    expect(await slotBelongsToPlan(h.db, planId, slotId, personId)).toBe(true);
    expect(await slotBelongsToPlan(h.db, planId, slotId, personId + 1)).toBe(false);
    expect(await manualItemExists(h.db, 1)).toBe(false);
    const [item] = await h.db.insert(s.groceryManual).values({ planId, text: "Synthetic item", checked: false }).returning({ id: s.groceryManual.id });
    expect(await manualItemExists(h.db, item!.id)).toBe(true);
  });
});
describe("device ownership", () => {
  const sub = { endpoint: "https://push.example.test/device", p256dh: "synthetic-p256dh", auth: "synthetic-auth" };
  it("atomically creates and refreshes its own registration but never transfers an endpoint", async () => {
    expect(await personExists(personId)).toBe(true);
    expect(await personExists(personId + 1)).toBe(false);
    expect(await savePushSubscription(personId, sub)).toBe(true);
    expect(await savePushSubscription(personId, { ...sub, auth: "refreshed" })).toBe(true);
    expect(await savePushSubscription(personId + 1, sub)).toBe(false);
    expect(await hasPushSubscription(personId, sub.endpoint)).toBe(true);
    expect(await hasPushSubscription(personId + 1, sub.endpoint)).toBe(false);
    await deletePushSubscription(sub.endpoint, personId + 1);
    expect(await hasPushSubscription(personId, sub.endpoint)).toBe(true);
    await deletePushSubscription(sub.endpoint, personId);
    expect(await h.db.select().from(s.pushSubscriptions)).toEqual([]);
  });
  it("keeps an existing registration if a refresh fails", async () => {
    await savePushSubscription(personId, sub);
    await h.failWrite("push_subscriptions", "update", "fail_push_update");
    try {
      await expect(savePushSubscription(personId, { ...sub, auth: "replacement" })).rejects.toThrow();
      expect(await h.db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.personId, personId))).toMatchObject([{ auth: sub.auth }]);
    } finally { await h.dropFailure("push_subscriptions", "fail_push_update"); }
  });
  it("does not send private notifications without a verified, current membership and unexpired session", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic-public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic-private");
    await savePushSubscription(personId, sub);
    const payload = { title: "Synthetic reminder", body: "Synthetic prep", url: "/" };
    expect(await sendToPerson(personId, payload)).toEqual({ sent: 0, failed: 0, removed: 0 });
    await h.db.insert(s.authUsers).values({ id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "fixture", userId: "cook", role: "member", personId });
    expect((await sendToPerson(personId, payload)).sent).toBe(0);
    await h.db.insert(s.authSessions).values({
      id: "session", userId: "cook", token: "synthetic-session", updatedAt: new Date(), expiresAt: new Date(Date.now() - 1000),
    });
    expect((await sendToPerson(personId, payload)).sent).toBe(0);
    await h.db.update(s.authSessions).set({ expiresAt: new Date(Date.now() + 60000) });
    await h.db.update(s.authUsers).set({ emailVerified: false });
    expect((await sendToPerson(personId, payload)).sent).toBe(0);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    await h.db.update(s.authUsers).set({ emailVerified: true });
    expect((await sendToPerson(personId, payload)).sent).toBe(1);
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    await h.db.delete(s.householdMembers);
    expect((await sendToPerson(personId, payload)).sent).toBe(0);
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
  });
});
