import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { test, expect } from "./member-fixture";
import { e2eTarget } from "./target";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { writeSavedView } from "../../lib/human/saved-views";

async function fixture() {
  return z.object({ endpoint: z.string().url(), secret: z.string() }).parse(JSON.parse(await readFile(".next-e2e-fixture/state-sync.json", "utf8")));
}
async function control(mode: "reset" | "healthy" | "failure" | "conflict") {
  const config = await fixture();
  const response = await fetch(`${config.endpoint}/__browser_control`, {
    method: "POST", headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" }, body: JSON.stringify({ mode }),
  });
  expect(response.status).toBe(200);
  return z.object({ head: z.string() }).parse(await response.json());
}
async function dirty() {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try { await writeSavedView(handle.db, { list: "recipes", query: `synthetic-sync-${randomUUID()}` }); }
  finally { await handle.close(); }
}
test.beforeEach(async () => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try { await handle.db.execute(sql`truncate table state_sync_jobs cascade`); } finally { await handle.close(); }
  await control("reset");
  await dirty();
});

test("owner syncs a pending snapshot through actual GitHub HTTP and can retry a lost browser request", async ({ page }) => {
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "Private shared-state sync" });
  await expect(card).toContainText("saved-views: pending");
  await expect(card).toContainText("Last successful sync: Never");
  await page.route("**/settings", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("could not be reached");
  await page.unroute("**/settings");
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("shared snapshot is synced");
  await expect(card).toContainText("saved-views: synced");
  await expect(card).toContainText("Status: success");
  await expect(card).not.toContainText("Last successful sync: Never");
  const successful = await control("healthy");
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
  expect(await control("healthy")).toEqual(successful);
  await page.screenshot({ path: "test-results/private-sync-phone.png", fullPage: true });
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    expect(await handle.db.select().from(s.stateSyncJobs)).toMatchObject([{ status: "success", leaseToken: null, pending: null, checkpointCommit: successful.head }]);
  } finally { await handle.close(); }
});

test("owner sees real upstream failure, retries successfully and refuses a managed conflict without losing last success", async ({ page }) => {
  await control("failure");
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "Private shared-state sync" });
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card).toContainText("Status: error");
  await expect(card).toContainText("saved-views: pending");
  await expect(card).toContainText("Last successful sync: Never");
  await control("healthy");
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card).toContainText("Status: success");
  await dirty();
  await control("conflict");
  await page.reload();
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(card).toContainText("Status: conflict");
  await expect(card).toContainText("Nothing was overwritten");
  await expect(card).toContainText("saved-views: pending");
  await expect(card).not.toContainText("Last successful sync: Never");
  await page.screenshot({ path: "test-results/private-sync-conflict-phone.png", fullPage: true });
});

test("a member cannot invoke the captured owner action and an anonymous context cannot see sync settings", async ({ page, browser }) => {
  await page.goto("/settings");
  const actionRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/settings" && !!request.headers()["next-action"]);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  const captured = await actionRequest;
  await expect(page.getByRole("region", { name: "Private shared-state sync" })).toContainText("Status: success");
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const [owner] = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers).where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
  try {
    await handle.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, owner!.id));
    await page.reload();
    await expect(page.getByRole("region", { name: "Private shared-state sync" })).toHaveCount(0);
    const before = await handle.db.select().from(s.stateSyncRequests);
    const denied = await page.request.post("/settings", {
      headers: { origin: "http://127.0.0.1:3112", "next-action": captured.headers()["next-action"]!, "content-type": captured.headers()["content-type"]! },
      data: captured.postData()!,
    });
    expect(denied.status()).toBe(200);
    expect(await denied.text()).toContain("Only a household owner");
    expect(await handle.db.select().from(s.stateSyncRequests)).toEqual(before);
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const publicPage = await anonymous.newPage();
      await publicPage.goto("/settings");
      await expect(publicPage).toHaveURL(/\/sign-in/);
      await expect(publicPage.getByRole("region", { name: "Private shared-state sync" })).toHaveCount(0);
    } finally { await anonymous.close(); }
  } finally {
    await handle.db.update(s.householdMembers).set({ role: "owner" }).where(eq(s.householdMembers.userId, owner!.id));
    await handle.close();
  }
});

test("scheduler requires its own credential and replays one successful request without a second commit", async ({ page }) => {
  const config = await fixture();
  const key = randomUUID();
  const denied = await page.request.post("/api/state-sync", { headers: { "idempotency-key": key } });
  expect(denied.status()).toBe(401);
  const headers = { authorization: `Bearer ${config.secret}`, "idempotency-key": key };
  const first = await page.request.post("/api/state-sync", { headers });
  expect(first.status()).toBe(200);
  expect(await first.json()).toEqual({ ok: true, state: "success", replayed: false });
  const head = await control("healthy");
  const repeated = await page.request.post("/api/state-sync", { headers });
  expect(await repeated.json()).toEqual({ ok: true, state: "success", replayed: true });
  expect(await control("healthy")).toEqual(head);
  const get = await page.request.get("/api/state-sync", { headers });
  expect(get.status()).toBe(405);
});
