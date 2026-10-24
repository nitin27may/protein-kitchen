import { readFile } from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { test, expect } from "./member-fixture";
import { e2eTarget } from "./target";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { loadData } from "../../lib/data/load";
import { persistNewPlan } from "../../lib/server/plan-persistence";

const config = async () => z.object({ endpoint: z.string().url(), secret: z.string(), schedulerSecret: z.string() })
  .parse(JSON.parse(await readFile(".next-e2e-fixture/reminders.json", "utf8")));
const keys = { p256dh: "synthetic-p256dh-key", auth: "synthetic-auth-key" };
const endpoint = (device: string) => `https://push.example.test/${device}`;
async function profile(db: ReturnType<typeof openPostgres>["db"]) {
  const [account] = await db.select({ personId: s.householdMembers.personId }).from(s.householdMembers)
    .innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId)).where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
  return account!.personId!;
}

test("synthetic device enable, test send, failed disable and retry use the real private routes", async ({ page }) => {
  await page.addInitScript(({ endpoint, keys }) => {
    const sub = {
      endpoint, toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { localStorage.removeItem("synthetic-device-enabled"); return true; },
    };
    const reg = { pushManager: {
      getSubscription: async () => localStorage.getItem("synthetic-device-enabled") ? sub : null,
      subscribe: async () => { localStorage.setItem("synthetic-device-enabled", "1"); return sub; },
    } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) } });
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Notification.requestPermission = async () => "granted";
  }, { endpoint: endpoint("browser-ui"), keys });
  const h = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const id = await profile(h.db);
    await page.goto(`/profiles/${id}`);
    await page.getByRole("button", { name: "Turn on reminders", exact: true }).click();
    await expect(page.getByText("Reminders are on for", { exact: false })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Send a test", exact: true }).click();
    await expect(page.getByText("Test sent. It should arrive in a few seconds.", { exact: true })).toBeVisible();
    const controls = await config();
    const stats = await page.request.get(`${controls.endpoint}/control`, { headers: { authorization: `Bearer ${controls.secret}` } });
    expect(await stats.json()).toMatchObject({ counts: { "/browser-ui": 1 } });
    await page.route("**/api/push/unsubscribe", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByText("Reminders could not be disabled. Check your connection and try again.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a test", exact: true })).toBeVisible();
    expect(await h.db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint("browser-ui")))).toHaveLength(1);
    await page.unroute("**/api/push/unsubscribe");
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByRole("button", { name: "Turn on reminders", exact: true })).toBeVisible();
    expect(await h.db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint("browser-ui")))).toEqual([]);
    await page.screenshot({ path: "test-results/reminder-device-phone.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("button", { name: "Turn on reminders", exact: true })).toBeVisible();
    await page.locator('section[aria-labelledby="rem"]').screenshot({ path: "test-results/reminder-device-desktop.png" });
  } finally {
    await h.db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint("browser-ui")));
    await h.close();
  }
});

test("real scheduler HTTP freezes devices, serializes dispatch, retries rejected devices and never repeats accepted or ambiguous sends", async ({ page }) => {
  const controls = await config();
  const headers = { authorization: `Bearer ${controls.schedulerSecret}` };
  const providerHeaders = { authorization: `Bearer ${controls.secret}` };
  const h = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  let planId: number | undefined;
  const id = await profile(h.db);
  const [before] = await h.db.select().from(s.people).where(eq(s.people.id, id));
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    await h.db.update(s.people).set({ reminderTime: now.toISOString().slice(11, 16), reminderTimezone: "UTC" }).where(eq(s.people.id, id));
    const recipe = [...loadData(process.cwd()).recipes.values()].find((r) => r.kind === "recipe" && r.meal_slots.includes("dinner") && r.advance_prep.some((p) => p.lead_hours >= 4))!;
    const recipes = await h.db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes);
    planId = await persistNewPlan(h.db, {
      setup: { householdId: before!.householdId!, personIds: [id], startDate: today, endDate: tomorrow, mealTypes: ["dinner"], cuisineBalance: 0.5, maxActiveMin: 20,
        healthFocus: { nutrientDense: false, lowSugar: true, light: true }, prepStyle: "leftovers", createdAt: now.toISOString() },
      seed: 12346, slots: [{ date: tomorrow, slot: "dinner", recipeSlug: recipe.slug, servings: { [id]: 1 }, locked: false, reasons: [] }],
      routines: [], recipeIds: new Map(recipes.map((r) => [r.slug, r.id])),
    });
    expect((await page.request.get("/api/reminders", { headers })).status()).toBe(405);
    expect((await page.request.post("/api/reminders")).status()).toBe(401);
    expect((await page.request.post("/api/reminders", { headers: providerHeaders })).status()).toBe(401);
    expect((await page.request.post("/api/reminders?personId=1", { headers })).status()).toBe(400);
    expect((await page.request.post("/api/reminders", { headers, data: { now: "2099-01-01" } })).status()).toBe(400);
    const empty = await page.request.post("/api/reminders", { headers });
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, sent: 0, retry: 0, ambiguous: 0, cancelled: 0 });
    expect(await h.db.select().from(s.reminderLog).where(and(eq(s.reminderLog.personId, id), eq(s.reminderLog.date, today)))).toEqual([]);
    for (const device of ["scheduler-a", "scheduler-b", "scheduler-c"]) {
      const registered = await page.request.post("/api/push/subscribe", {
        headers: { origin: "http://127.0.0.1:3112" }, data: { personId: id, endpoint: endpoint(device), keys },
      });
      expect(registered.status()).toBe(200);
    }
    expect((await page.request.post(`${controls.endpoint}/control`, {
      headers: providerHeaders, data: { statuses: { "/scheduler-b": 429, "/scheduler-c": 503 } },
    })).status()).toBe(200);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => page.request.post("/api/reminders", { headers })));
    const results = await Promise.all(concurrent.map((response) => response.json()));
    expect(results.reduce((total, result) => total + Number(result.sent), 0)).toBe(1);
    expect(concurrent.some((response) => response.status() === 503)).toBe(true);
    const counts = async () => (await (await page.request.get(`${controls.endpoint}/control`, { headers: providerHeaders })).json()).counts;
    expect(await counts()).toMatchObject({ "/scheduler-a": 1, "/scheduler-b": 1, "/scheduler-c": 1 });
    await page.request.post("/api/reminders", { headers });
    expect(await counts()).toMatchObject({ "/scheduler-a": 1, "/scheduler-b": 1, "/scheduler-c": 1 });
    const [batch] = await h.db.select().from(s.reminderBatches).where(and(eq(s.reminderBatches.personId, id), eq(s.reminderBatches.date, today)));
    expect(batch).toBeDefined();
    await h.db.update(s.reminderDeliveries).set({ retryAt: "2000-01-01T00:00:00Z" }).where(eq(s.reminderDeliveries.batchId, batch!.id));
    await page.request.post(`${controls.endpoint}/control`, { headers: providerHeaders, data: { statuses: { "/scheduler-b": 500 } } });
    const retried = await page.request.post("/api/reminders", { headers });
    expect(retried.status()).toBe(503);
    expect(await retried.json()).toEqual({ ok: false, sent: 1, retry: 0, ambiguous: 1, cancelled: 0 });
    await page.request.post("/api/reminders", { headers });
    expect(await counts()).toMatchObject({ "/scheduler-a": 1, "/scheduler-b": 2, "/scheduler-c": 2 });
    const receipts = await h.db.select().from(s.reminderDeliveries).where(eq(s.reminderDeliveries.batchId, batch!.id));
    expect(receipts.map((r) => r.status).sort()).toEqual(["accepted", "accepted", "ambiguous"]);
    const text = JSON.stringify(results);
    expect(text).not.toContain("Synthetic");
    expect(text).not.toContain("push.example.test");
    expect(retried.headers()["cache-control"]).toBe("private, no-store");
  } finally {
    if (planId) await h.db.delete(s.plans).where(eq(s.plans.id, planId));
    await h.db.update(s.people).set({ reminderTime: before!.reminderTime, reminderTimezone: before!.reminderTimezone }).where(eq(s.people.id, id));
    for (const device of ["scheduler-a", "scheduler-b", "scheduler-c"]) await h.db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.endpoint, endpoint(device)));
    await h.close();
  }
});
