import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { claimReminder } from "../lib/reminders/claim";
import { checkReminders } from "../lib/server/push";
import { getDb } from "../lib/server/context";
import { listPeople } from "../lib/server/queries";
import { APP_TZ } from "../lib/server/time";
import { localParts } from "../lib/reminders/due";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/server/queries", () => ({ listPeople: vi.fn(), latestPlanId: async () => undefined, getPlanView: vi.fn() }));
vi.mock("../lib/server/prep", () => ({ loadNight: vi.fn(), tonight: () => [{ text: "Synthetic preparation", forName: "Synthetic meal", done: false }] }));

const now = new Date("2026-10-24T01:00:00.000Z");
const { date, hhmm } = localParts(now, APP_TZ);
let h: DbHandle;
const reminder = (personId = 1, day = date) => ({ personId, date: day, sentAt: now.toISOString() });
beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.people).values({
    id: 1, name: "Synthetic cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
    activityLevel: "moderate", reminderTime: hhmm, dietFlags: [],
  });
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(listPeople).mockResolvedValue(await h.db.select().from(s.people));
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
    await h.db.insert(s.reminderLog).values(reminder());
    expect(await claimReminder(h.db, reminder())).toBe(false);
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
  it("lets only the winning actual dispatcher reach the synthetic push provider", async () => {
    await h.db.insert(s.authUsers).values({ id: "synthetic-user", name: "Synthetic cook", email: "reminder@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ userId: "synthetic-user", personId: 1, role: "owner" });
    await h.db.insert(s.authSessions).values({
      id: "synthetic-session", token: "synthetic-reminder-session", userId: "synthetic-user",
      expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(),
    });
    await h.db.insert(s.pushSubscriptions).values({
      personId: 1, endpoint: "https://push.example.test/synthetic", p256dh: "synthetic", auth: "synthetic", createdAt: now.toISOString(),
    });
    const results = await Promise.all([checkReminders(now), checkReminders(now)]);
    expect(results.reduce((total, result) => total + result, 0)).toBe(1);
    expect(provider.send).toHaveBeenCalledOnce();
    expect(await checkReminders(now)).toBe(0);
    expect(provider.send).toHaveBeenCalledOnce();
  });
});
