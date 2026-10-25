import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { claimReminder } from "../lib/reminders/claim";
import { dispatchReminders } from "../lib/server/push";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/server/context";
import { APP_TZ } from "../lib/server/time";
import { localParts } from "../lib/reminders/due";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));
vi.mock("../lib/reminders/context", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/reminders/context")>(),
  householdReminderTasks: async () => ["Synthetic preparation, for Synthetic meal"],
}));

const now = new Date();
const { date, hhmm } = localParts(now, APP_TZ);
let h: DbHandle;
const reminder = (personId = 1, day = date) => ({ personId, date: day, sentAt: now.toISOString() });
const checkReminders = async (at: Date) => (await dispatchReminders(at)).sent;
async function eligibleDevice() {
  await h.db.insert(s.authUsers).values({ id: "synthetic-user", name: "Synthetic cook", email: "reminder@example.test", emailVerified: true });
  await h.db.insert(s.householdMembers).values({ householdId: "fixture", userId: "synthetic-user", personId: 1, role: "owner" });
  await h.db.insert(s.authSessions).values({
    id: "synthetic-session", token: "synthetic-reminder-session", userId: "synthetic-user",
    expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(),
  });
  await h.db.insert(s.pushSubscriptions).values({
    personId: 1, endpoint: "https://push.example.test/synthetic", p256dh: "synthetic", auth: "synthetic", createdAt: now.toISOString(),
  });
}
beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values({ id: "fixture", name: "Synthetic household" });
  await h.db.insert(s.people).values({
    householdId: "fixture",
    id: 1, name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "moderate", reminderTime: hhmm, dietFlags: [],
  });
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.stubEnv("VAPID_PUBLIC_KEY", "synthetic-public"); vi.stubEnv("VAPID_PRIVATE_KEY", "synthetic-private");
  provider.send.mockResolvedValue({});
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("atomic daily reminder admission", () => {
  it("admits exactly one of eight concurrent claims and preserves its original timestamp", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimReminder(h.db, reminder())));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimReminder(h.db, { ...reminder(), sentAt: "2026-10-24T02:00:00.000Z" })).toBe(false);
    expect(await h.db.select().from(s.reminderLog)).toEqual([reminder()]);
  });
  it("preserves historical claims and admits a different calendar day independently", async () => {
    await h.db.insert(s.reminderLog).values(reminder(1, "2026-10-24"));
    expect(await claimReminder(h.db, reminder(1, "2026-10-24"))).toBe(false);
    expect(await claimReminder(h.db, reminder(1, "2026-10-25"))).toBe(true);
  });
  it("keeps separate cooks independent on the same day", async () => {
    const [original] = await h.db.select().from(s.people);
    await h.db.insert(s.people).values({ ...original!, id: 2, name: "Second synthetic cook" });
    expect(await claimReminder(h.db, reminder())).toBe(true);
    expect(await claimReminder(h.db, reminder(2))).toBe(true);
  });
  it("propagates a failed database write without reporting admission", async () => {
    await expect(claimReminder(h.db, reminder(999))).rejects.toThrow();
    expect(await h.db.select().from(s.reminderLog)).toEqual([]);
    expect(await claimReminder(h.db, reminder())).toBe(true);
  });
  it("claims the cook's local day when its timezone differs from the household", async () => {
    await eligibleDevice();
    const later = new Date("2099-10-24T15:30:00Z");
    await h.db.update(s.people).set({ reminderTime: "04:30", reminderTimezone: "Pacific/Auckland" }).where(eq(s.people.id, 1));
    expect(await checkReminders(later)).toBe(1);
    expect(await h.db.select().from(s.reminderLog)).toMatchObject([{ personId: 1, date: "2099-10-25" }]);
    expect(await checkReminders(later)).toBe(0);
    expect(await h.db.select().from(s.reminderLog)).toHaveLength(1);
  });
  it("lets only the winning actual dispatcher reach the synthetic push provider", async () => {
    await eligibleDevice();
    const results = await Promise.all([checkReminders(now), checkReminders(now)]);
    expect(results.reduce((total, result) => total + result, 0)).toBe(1);
    expect(provider.send).toHaveBeenCalledOnce();
    expect(await checkReminders(now)).toBe(0);
    expect(provider.send).toHaveBeenCalledOnce();
  });
  it.each([429, 503, 410, 500])("persists the actual dispatcher's %s outcome and never blindly duplicates it", async (statusCode) => {
    await eligibleDevice();
    provider.send.mockRejectedValueOnce({ statusCode });
    expect(await checkReminders(now)).toBe(0);
    const [receipt] = await h.db.select().from(s.reminderDeliveries);
    expect(receipt!.status).toBe(statusCode === 410 ? "gone" : statusCode === 500 ? "ambiguous" : "retry");
    expect(await checkReminders(now)).toBe(0);
    expect(provider.send).toHaveBeenCalledOnce();
  });
});
