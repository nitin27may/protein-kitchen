import { test, expect } from "./member-fixture";
import type { Page, Route } from "@playwright/test";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { e2eTarget } from "./target";

async function mutation(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).origin === "http://127.0.0.1:3112");
  await action();
  expect((await response).status()).toBe(200);
}

async function currentSession(page: Page, db: ReturnType<typeof openPostgres>["db"]) {
  const cookie = (await page.context().cookies()).find((value) => value.name.endsWith("session_token"));
  expect(cookie).toBeDefined();
  const token = decodeURIComponent(cookie!.value).split(".")[0]!;
  const [session] = await db.select().from(s.authSessions).where(eq(s.authSessions.token, token));
  expect(session).toBeDefined();
  return session!;
}

test("plan generation, swap and locked regeneration survive reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/plan/new");
  await expect(page.getByRole("button", { name: "Generate plan", exact: true })).toBeVisible();
  await mutation(page, () => page.getByRole("button", { name: "Generate plan", exact: true }).click());
  await expect(page).toHaveURL(/\/plan\/\d+(\?.*)?$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Swap", exact: true }).first().click();
  const pick = page.getByRole("button", { name: "Pick this", exact: true }).first();
  await expect(pick).toBeVisible();
  const candidate = await pick.locator("..").locator("p").first().innerText();
  await mutation(page, () => pick.click());
  await page.reload();
  await expect(page.getByRole("main")).toContainText(candidate);
  await mutation(page, () => page.getByRole("button", { name: "Lock", exact: true }).first().click());
  await mutation(page, () => page.getByRole("button", { name: "Regenerate", exact: true }).click());
  await page.reload();
  await expect(page.getByRole("main")).toContainText(candidate);
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
});

test("plan setup and reloaded plan controls wait for hydration rather than discarding their first click", async ({ page }) => {
  let release = () => {};
  let scriptsReady = Promise.resolve();
  function pauseScripts() {
    scriptsReady = new Promise<void>((resolve) => { release = resolve; });
  }
  const delayScripts = async (route: Route) => {
    if (route.request().resourceType() === "script") await scriptsReady;
    await route.continue();
  };
  await page.route("**/_next/static/**", delayScripts);
  try {
    pauseScripts();
    await page.goto("/plan/new", { waitUntil: "commit" });
    const generate = page.getByRole("button", { name: "Generate plan", exact: true });
    await expect(generate).toBeVisible();
    await expect(generate).toBeDisabled();
    release();
    await expect(generate).toBeEnabled();
    await mutation(page, () => generate.click());
    await expect(page).toHaveURL(/\/plan\/\d+(\?.*)?$/);
    pauseScripts();
    await page.reload({ waitUntil: "commit" });
    const lock = page.getByRole("button", { name: "Lock", exact: true }).first();
    await expect(lock).toBeVisible();
    await expect(lock).toBeDisabled();
    release();
    await expect(lock).toBeEnabled();
    await mutation(page, () => lock.click());
    await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
  } finally {
    release();
    await page.unroute("**/_next/static/**", delayScripts);
  }
});

test("shopping and prep ticks wait for hydration and preserve their first saved change", async ({ page }) => {
  for (const path of ["/groceries", `/plan/${process.env.E2E_PREP_PLAN_ID}/prep`]) {
    let release = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const delayScripts = async (route: Route) => {
      if (route.request().resourceType() === "script") await ready;
      await route.continue();
    };
    await page.route("**/_next/static/**", delayScripts);
    try {
      await page.goto(path, { waitUntil: "commit" });
      const checkbox = page.getByRole("checkbox").first();
      await expect(checkbox).toBeVisible();
      await expect(checkbox).toBeDisabled();
      release();
      await expect(checkbox).toBeEnabled();
      await page.unroute("**/_next/static/**", delayScripts);
      const checked = await checkbox.isChecked();
      await mutation(page, () => checkbox.setChecked(!checked));
      await page.reload();
      await expect(checkbox).toBeChecked({ checked: !checked });
    } finally {
      release();
      await page.unroute("**/_next/static/**", delayScripts);
    }
  }
});

test("shopping progress is shared between independent browser contexts and persists", async ({ page, browser }) => {
  await page.goto("/groceries");
  const first = page.getByRole("checkbox").first();
  await expect(first).toBeVisible();
  const value = await first.isChecked();
  await mutation(page, () => first.setChecked(!value));
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await other.addCookies(await page.context().cookies());
    const second = await other.newPage();
    await second.goto("http://127.0.0.1:3112/groceries");
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: !value });
    await page.reload();
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !value });
  } finally { await other.close(); }
});

test("household chooser retries failures, completes only the selected profile and switches back without merging data", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const householdId = randomUUID();
  const name = "Synthetic second household for shared meal planning";
  let selectedSession: typeof s.authSessions.$inferSelect | undefined;
  try {
    const [account] = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers)
      .where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
    selectedSession = await currentSession(page, handle.db);
    const profiles = await handle.db.select().from(s.people);
    const plans = await handle.db.select().from(s.plans);
    await handle.db.insert(s.households).values({ id: householdId, name });
    await handle.db.insert(s.householdMembers).values({ householdId, userId: account!.id, role: "owner" });
    await page.goto("/groceries");
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Choose a household", exact: true })).toBeVisible();
    const choice = page.getByRole("button", { name: `Use household: ${name}`, exact: true });
    await expect(choice).toBeVisible();
    const bounds = await choice.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
    await page.route("**/onboarding", async (route) => {
      if (route.request().method() === "POST") await route.abort("failed");
      else await route.continue();
    });
    await choice.click();
    await expect(page.getByRole("alert").filter({ hasText: "Check your connection" })).toBeVisible();
    await page.unroute("**/onboarding");
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
    await choice.click();
    await expect(page.getByRole("alert").filter({ hasText: "not available" })).toBeVisible();
    await handle.db.insert(s.householdMembers).values({ householdId, userId: account!.id, role: "owner" });
    const outgoing = page.waitForRequest((request) => request.method() === "POST" && !!request.headers()["next-action"]);
    await choice.click();
    const captured = await outgoing;
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Synthetic selected profile");
    await page.getByLabel("Date of birth", { exact: true }).fill("2000-01-01");
    await page.getByLabel("Height (cm)", { exact: true }).fill("170");
    await page.getByLabel("Weight (kg)", { exact: true }).fill("70");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page).not.toHaveURL(/\/onboarding/);
    await page.goto("/account");
    await expect(page.getByRole("link", { name: "Profile: Synthetic selected profile", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "Profile: Synthetic selected profile", exact: true })).toBeVisible();
    const denied = await page.request.post("/onboarding", {
      headers: {
        origin: "http://127.0.0.1:3112", "next-action": captured.headers()["next-action"]!,
        "content-type": captured.headers()["content-type"]!,
      }, data: JSON.stringify(["foreign-household-selection"]),
    });
    expect(await denied.text()).toContain("not available");
    await page.getByRole("link", { name: "Switch household", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose a household", exact: true })).toBeVisible();
    await expect(page.getByText(`${name} (current)`, { exact: true })).toBeVisible();
    const [original] = await handle.db.select().from(s.households).where(eq(s.households.id, "00000000-0000-4000-8000-000000000001"));
    await page.getByRole("button", { name: `Use household: ${original!.name}`, exact: true }).click();
    await expect(page.getByRole("link", { name: "Profile: Synthetic authorized fixture", exact: true })).toBeVisible();
    expect(await handle.db.select().from(s.people).where(eq(s.people.householdId, householdId)))
      .toMatchObject([{ name: "Synthetic selected profile" }]);
    for (const profile of profiles) expect(await handle.db.select().from(s.people).where(eq(s.people.id, profile.id))).toEqual([profile]);
    expect(await handle.db.select().from(s.plans)).toEqual(plans);
  } finally {
    if (selectedSession) await handle.db.update(s.authSessions).set({
      activeHouseholdId: selectedSession.activeHouseholdId,
      householdSelectionVersion: sql`${s.authSessions.householdSelectionVersion} + 1`,
    }).where(eq(s.authSessions.id, selectedSession.id));
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
    await handle.db.delete(s.people).where(eq(s.people.householdId, householdId));
    await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    await handle.close();
  }
});

test("two real sessions of one account use separate selected households and reject captured foreign-plan actions", async ({ page, browser }) => {
  await page.goto("/groceries");
  const checkbox = page.getByRole("checkbox").first();
  await expect(checkbox).toBeVisible();
  const original = await checkbox.isChecked();
  const outgoing = page.waitForRequest((request) => request.method() === "POST" && !!request.headers()["next-action"]);
  await mutation(page, () => checkbox.setChecked(!original));
  const captured = await outgoing;
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const householdId = randomUUID();
  let primary: typeof s.authSessions.$inferSelect | undefined;
  let secondarySessionId: string | undefined;
  let personId: number | undefined;
  try {
    const [account] = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers)
      .where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
    const sessions = await handle.db.select().from(s.authSessions).where(eq(s.authSessions.userId, account!.id));
    primary = await currentSession(page, handle.db);
    await handle.db.insert(s.households).values({ id: householdId, name: "Separate selected household" });
    const [profile] = await handle.db.insert(s.people).values({
      householdId, name: "Secondary selected profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    personId = profile!.id;
    await handle.db.insert(s.householdMembers).values({ householdId, userId: account!.id, role: "member", personId });
    await handle.db.update(s.authSessions).set({
      activeHouseholdId: "00000000-0000-4000-8000-000000000001",
      householdSelectionVersion: primary.householdSelectionVersion + 1,
    }).where(eq(s.authSessions.id, primary.id));
    const login = await other.request.post("http://127.0.0.1:3112/api/auth/sign-in/email", {
      headers: { origin: "http://127.0.0.1:3112", "x-forwarded-for": "127.0.0.32" },
      data: { email: "authorized-browser-fixture@example.test", password: "Synthetic-authorized-browser-password-123!" },
    });
    expect(login.status()).toBe(200);
    const secondSessions = (await handle.db.select().from(s.authSessions).where(eq(s.authSessions.userId, account!.id)))
      .filter((session) => !sessions.some((existing) => existing.id === session.id));
    expect(secondSessions).toHaveLength(1);
    secondarySessionId = secondSessions[0]!.id;
    await handle.db.update(s.authSessions).set({ activeHouseholdId: householdId, householdSelectionVersion: 1 })
      .where(eq(s.authSessions.id, secondarySessionId));
    const second = await other.newPage();
    await second.goto("http://127.0.0.1:3112/account");
    await expect(second.getByRole("link", { name: "Profile: Secondary selected profile", exact: true })).toBeVisible();
    await expect(second.getByRole("heading", { name: "Household cooks", exact: true })).toHaveCount(0);
    await page.goto("/account");
    await expect(page.getByRole("link", { name: "Profile: Synthetic authorized fixture", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Household cooks", exact: true })).toBeVisible();
    await second.goto("http://127.0.0.1:3112/profiles");
    await expect(second.getByText("Secondary selected profile", { exact: true })).toBeVisible();
    await expect(second.getByText("Synthetic authorized fixture", { exact: true })).toHaveCount(0);
    const download = await other.request.get("http://127.0.0.1:3112/api/account/export");
    expect(download.status()).toBe(200);
    const file = await download.json();
    expect(file.profile.name).toBe("Secondary selected profile");
    expect(JSON.stringify(file)).not.toContain(primary.token);
    const before = await handle.db.select().from(s.groceryState);
    const denied = await other.request.post("http://127.0.0.1:3112/groceries", {
      headers: {
        origin: "http://127.0.0.1:3112", "next-action": captured.headers()["next-action"]!,
        "content-type": captured.headers()["content-type"]!,
      },
      data: captured.postData()!,
    });
    expect(denied.status()).toBe(200);
    expect(await denied.text()).toContain("not available");
    expect(await handle.db.select().from(s.groceryState)).toEqual(before);
    await page.goto("/groceries");
    await mutation(page, () => page.getByRole("checkbox").first().setChecked(original));
  } finally {
    await other.close();
    if (secondarySessionId) await handle.db.delete(s.authSessions).where(eq(s.authSessions.id, secondarySessionId));
    if (primary) await handle.db.update(s.authSessions).set({
      activeHouseholdId: primary.activeHouseholdId, householdSelectionVersion: primary.householdSelectionVersion + 2,
    }).where(eq(s.authSessions.id, primary.id));
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
    if (personId !== undefined) await handle.db.delete(s.people).where(eq(s.people.id, personId));
    await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    await handle.close();
  }
});

test("ambiguous household membership blocks private pages, downloads and captured mutations until resolved", async ({ page }) => {
  await page.goto("/groceries");
  const checkbox = page.getByRole("checkbox").first();
  await expect(checkbox).toBeVisible();
  const original = await checkbox.isChecked();
  const outgoing = page.waitForRequest((request) => request.method() === "POST" && !!request.headers()["next-action"]);
  await mutation(page, () => checkbox.setChecked(!original));
  const captured = await outgoing;
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const householdId = randomUUID();
  try {
    const [account] = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers)
      .where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
    expect(account).toBeDefined();
    await handle.db.insert(s.households).values({ id: householdId, name: "Explicit selection fixture" });
    await handle.db.insert(s.householdMembers).values({ householdId, userId: account!.id, role: "member" });
    const before = await handle.db.select().from(s.groceryState);
    const denied = await page.request.post("/groceries", {
      headers: {
        origin: "http://127.0.0.1:3112", "next-action": captured.headers()["next-action"]!,
        "content-type": captured.headers()["content-type"]!,
      },
      data: captured.postData()!,
    });
    expect(denied.status()).toBe(200);
    expect(await denied.text()).toContain("Select an available household");
    expect(await handle.db.select().from(s.groceryState)).toEqual(before);
    const download = await page.request.get("/api/account/export");
    expect(download.status()).toBe(403);
    expect(await download.text()).toContain("Select an available household");
    await page.goto("/groceries");
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Choose a household", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
    await page.goto("/groceries");
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !original });
    await mutation(page, () => page.getByRole("checkbox").first().setChecked(original));
  } finally {
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId));
    await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    await handle.close();
  }
});

test("night-before prep completion survives reload", async ({ page }) => {
  await page.goto(`/plan/${process.env.E2E_PREP_PLAN_ID}/prep`);
  const checkbox = page.getByRole("checkbox").first();
  await expect(checkbox).toBeVisible();
  const checked = await checkbox.isChecked();
  await mutation(page, () => checkbox.setChecked(!checked));
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const householdId = randomUUID();
  try {
    await handle.db.insert(s.households).values({ id: householdId, name: "Independent prep fixture" });
    const own = await handle.db.select().from(s.prepTaskState).where(eq(s.prepTaskState.householdId, "00000000-0000-4000-8000-000000000001"));
    expect(own.length).toBeGreaterThan(0);
    await handle.db.insert(s.prepTaskState).values(own.map((row) => ({ ...row, householdId })));
    const foreign = await handle.db.select().from(s.prepTaskState).where(eq(s.prepTaskState.householdId, householdId));
    await mutation(page, () => page.getByRole("checkbox").first().setChecked(checked));
    await page.reload();
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked });
    expect(await handle.db.select().from(s.prepTaskState).where(eq(s.prepTaskState.householdId, householdId))).toEqual(foreign);
  } finally {
    await handle.db.delete(s.prepTaskState).where(eq(s.prepTaskState.householdId, householdId));
    await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    await handle.close();
  }
});

test("household Settings reset keeps the recovery gate closed for ordinary and typed scopes", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const plans = await handle.db.select().from(s.plans);
    const people = await handle.db.select().from(s.people);
    const photos = await handle.db.select().from(s.photos);
    for (const title of ["plans", "everything"]) {
      await page.goto("/settings");
      const section = page.getByRole("region", { name: "Reset data" });
      await expect(section).toContainText("Resets affect only this household");
      await section.getByRole("button", { name: `Reset ${title}`, exact: true }).click();
      if (title === "everything") {
        await expect(section.getByRole("button", { name: "Reset everything", exact: true })).toBeDisabled();
        await section.getByLabel("Type RESET to confirm").fill("RESET");
      }
      await mutation(page, () => section.getByRole("button", { name: `Reset ${title}`, exact: true }).click());
      await expect(section.getByRole("alert")).toContainText("verified Postgres backup and restore procedure");
      expect(await handle.db.select().from(s.plans)).toEqual(plans);
      expect(await handle.db.select().from(s.people)).toEqual(people);
      expect(await handle.db.select().from(s.photos)).toEqual(photos);
    }
  } finally { await handle.close(); }
});

test("Excel and PDF exports return actual file payloads", async ({ request }) => {
  const id = process.env.E2E_PREP_PLAN_ID;
  const excel = await request.get(`/api/plan/${id}/export?format=xlsx`);
  expect(excel.status()).toBe(200);
  expect(excel.headers()["content-type"]).toContain("spreadsheetml");
  expect((await excel.body()).subarray(0, 2).toString()).toBe("PK");
  const pdf = await request.get(`/api/plan/${id}/export?format=pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
});

test("a curator's library photo rejection persists, and a failed request displays an error then allows retry", async ({ page }) => {
  test.skip(process.env.PHOTO_REVIEW_ENABLED === "false", "Candidate review is switched off");
  await page.goto("/photos/review");
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  const count = await reject.count();
  expect(count).toBeGreaterThan(0);
  await mutation(page, () => reject.first().click());
  await expect(reject).toHaveCount(count - 1);
  await page.reload();
  await expect(reject).toHaveCount(count - 1);
  await page.route("**/photos/review", async (route) => {
    if (route.request().method() === "POST") await route.abort("failed");
    else await route.continue();
  });
  await reject.first().click();
  await expect(page.getByRole("alert").filter({ hasText: "The photo decision could not" })).toBeVisible();
  await expect(reject).toHaveCount(count - 1);
  await page.unroute("**/photos/review");
  await mutation(page, () => reject.first().click());
  await expect(reject).toHaveCount(count - 2);
  await page.reload();
  await expect(reject).toHaveCount(count - 2);
  // The decisions are library decisions (shared, no household), written by the curator's person.
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const rows = await handle.db.select().from(s.libraryPhotoDecisions);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.decision === "rejected" && r.createdByPersonId !== null)).toBe(true);
    // The imported fixture household already had one private decision; the curator's clicks added none.
    expect(await handle.db.select().from(s.photoDecisions)).toHaveLength(1);
  } finally { await handle.close(); }
});

test("private photo upload, reload and deletion preserve actual WebP bytes and recover from request failures", async ({ page, browser }) => {
  const recipe = "/recipes/tofu-burrito-bowl";
  await page.goto(recipe);
  const photos = page.locator('section[aria-labelledby="photos"]');
  const file = {
    name: "synthetic-meal.jpg", mimeType: "image/jpeg",
    buffer: await sharp({ create: { width: 900, height: 600, channels: 3, background: "#c87828" } }).jpeg().toBuffer(),
  };
  // The picker has no handler until the page hydrates; it is disabled until then, so wait for it.
  await expect(photos.getByRole("button", { name: "Add a photo", exact: true })).toBeEnabled();
  await page.route("**/recipes/tofu-burrito-bowl", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await photos.locator('input[type="file"]').setInputFiles(file);
  await expect(photos.getByRole("alert")).toContainText("could not be uploaded");
  await expect(photos.getByRole("button", { name: "Add a photo", exact: true })).toBeEnabled();
  await page.unroute("**/recipes/tofu-burrito-bowl");
  await photos.locator('input[type="file"]').setInputFiles(file);
  await expect(photos.getByText("Your photo", { exact: false })).toBeVisible();
  await expect(photos.getByRole("button", { name: "Add another", exact: true })).toBeEnabled();
  await page.reload();
  const image = photos.locator("img").first();
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  expect(url).toMatch(/^\/photos\/[0-9a-f-]+\/thumb$/);
  const response = await page.request.get(url!);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const metadata = await sharp(await response.body()).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.exif).toBeUndefined();
  expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(640);
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    expect((await anonymous.request.get(`http://127.0.0.1:3112${url}`)).status()).toBe(401);
  } finally { await anonymous.close(); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
  await page.screenshot({ path: "test-results/private-photo-phone.png", fullPage: true });
  await photos.getByRole("button", { name: "Delete", exact: true }).click();
  await page.route("**/recipes/tofu-burrito-bowl", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await photos.getByRole("button", { name: "Delete photo", exact: true }).click();
  await expect(photos.getByRole("alert")).toContainText("photo change could not be saved");
  await expect(image).toBeVisible();
  await page.unroute("**/recipes/tofu-burrito-bowl");
  await photos.getByRole("button", { name: "Delete", exact: true }).click();
  await photos.getByRole("button", { name: "Delete photo", exact: true }).click();
  await expect(photos.getByText("No photo yet.", { exact: false })).toBeVisible();
  await page.reload();
  expect((await page.request.get(url!)).status()).toBe(404);
});
