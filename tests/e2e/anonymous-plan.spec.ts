import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { testMailPath } from "../../lib/auth/test-mail";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { noHorizontalScroll, smallTargets } from "./layout";
import { e2eTarget } from "./target";

/**
 * Anonymous planning and the signup gate, against the real app, a disposable loopback database and the synthetic
 * mailbox. Each journey uses its own example.test address and forwarded address so rate limits do not interact.
 */
const SHEET = "Create your account to continue";

async function code(email: string) {
  return z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in"), "utf8"))).otp;
}

async function makePlan(page: Page, weight = "75") {
  await page.goto("/plan/new");
  await expect(page.getByRole("heading", { name: "New plan", exact: true })).toBeVisible();
  await page.getByLabel("Name (optional)").fill("Tester");
  await page.getByLabel("Weight, kg").fill(weight);
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Generate plan", exact: true }).first().click();
  await expect(page).toHaveURL(/\/plan\/draft$/);
  await expect(page.getByText("This plan is on this device only")).toBeVisible();
}

async function signUpInSheet(page: Page, email: string) {
  const dialog = page.getByRole("dialog", { name: SHEET });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Check your email to continue");
  await dialog.getByLabel("Six-digit email code").fill(await code(email));
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

async function finishProfile(page: Page) {
  await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Synthetic gate cook");
  await page.getByLabel("Date of birth").fill("2000-01-01");
  await page.getByLabel("Height (cm)").fill("170");
  await page.getByLabel("Weight (kg)").fill("70");
  await page.getByRole("radio", { name: "Fixed grams", exact: true }).click();
  await page.getByLabel("Protein (g per day)", { exact: true }).fill("95");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
}

async function deviceKeys(page: Page) {
  return page.evaluate(() => ({
    session: Object.keys(sessionStorage).filter((k) => k.startsWith("pk-")),
    local: Object.keys(localStorage).filter((k) => k.startsWith("pk-") && k !== "pk-theme"),
  }));
}

async function overview(page: Page) {
  await page.getByRole("radio", { name: "Overview", exact: true }).click();
  return (await page.getByRole("table").innerText()).replace(/\s+/g, " ");
}

async function withDb<T>(task: (db: ReturnType<typeof openPostgres>["db"]) => Promise<T>) {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try { return await task(handle.db); } finally { await handle.close(); }
}

test("anonymous plan: generate, swap, save, sign up by code, and the same meals are in the new kitchen", async ({ page }) => {
  test.setTimeout(240_000);
  const email = "gate-plan@example.test";
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.61" });
  await makePlan(page);

  // Swap the first meal on the device. Nothing was sent to the server for any of this.
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && !r.url().includes("/api/auth")) writes.push(r.url()); });
  const firstMeal = page.locator("main ul > li").filter({ has: page.getByRole("button", { name: "Swap", exact: true }) }).first().getByRole("link").first();
  const before = await firstMeal.innerText();
  await page.getByRole("button", { name: "Swap", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Swap meal" });
  await sheet.getByRole("button", { name: "Pick this" }).first().click();
  await expect(page.getByText(/^Swapped to /)).toBeVisible();
  // The notice and the list update in separate renders, so wait for the list rather than reading it once.
  await expect(firstMeal).not.toHaveText(before);
  await page.getByRole("button", { name: "Lock", exact: true }).nth(1).click();
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toHaveCount(1);
  expect(writes).toEqual([]);

  const draft = JSON.parse(await page.evaluate(() => sessionStorage.getItem("pk-anon-draft")!)) as { slots: { date: string; slot: string; recipeSlug: string; locked: boolean }[] };
  const planned = await overview(page);

  await page.getByRole("button", { name: "Save plan", exact: true }).first().click();
  await signUpInSheet(page, email);
  await finishProfile(page);

  await expect(page).toHaveURL(/\/plan\/\d+$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("Plan saved to your kitchen");
  expect(await overview(page)).toBe(planned);

  const planId = Number(new URL(page.url()).pathname.split("/").pop());
  const stored = await withDb(async (db) => {
    const [owner] = await db.select({ id: s.authUsers.id }).from(s.authUsers).where(eq(s.authUsers.email, email));
    const [member] = await db.select({ householdId: s.householdMembers.householdId }).from(s.householdMembers).where(eq(s.householdMembers.userId, owner!.id));
    const [plan] = await db.select({ householdId: s.plans.householdId }).from(s.plans).where(eq(s.plans.id, planId));
    const rows = await db.select({ date: s.planSlots.date, slot: s.planSlots.slot, slug: s.recipes.slug, locked: s.planSlots.locked })
      .from(s.planSlots).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId)).where(eq(s.planSlots.planId, planId));
    return { sameHousehold: member!.householdId === plan!.householdId, rows };
  });
  expect(stored.sameHousehold).toBe(true);
  const key = (x: { date: string; slot: string }) => `${x.date}|${x.slot}`;
  expect(new Map(stored.rows.map((r) => [key(r), `${r.slug}|${r.locked}`])))
    .toEqual(new Map(draft.slots.map((d) => [key(d), `${d.recipeSlug}|${d.locked}`])));
  expect(await deviceKeys(page)).toEqual({ session: [], local: [] });
});

test("anonymous favourite: Favourite stays visible, asks for an email, and is saved after signup", async ({ page }) => {
  test.setTimeout(180_000);
  const email = "gate-favourite@example.test";
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.62" });
  await page.goto("/recipes/tofu-burrito-bowl");
  const favourite = page.getByRole("button", { name: "Favourite", exact: true });
  await expect(favourite).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add a link" })).toBeEnabled();
  await favourite.click();
  await expect(favourite).toHaveAttribute("aria-pressed", "false");
  expect(await deviceKeys(page)).toMatchObject({ session: expect.arrayContaining(["pk-pending-intent"]) });
  await signUpInSheet(page, email);
  await finishProfile(page);
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("Saved");
  await page.reload();
  await expect(page.getByRole("button", { name: "Favourite", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await deviceKeys(page)).toEqual({ session: [], local: [] });
});

test("an action replay cannot finish returns the person to the page with a clear message", async ({ page }) => {
  test.setTimeout(240_000);
  const email = "gate-rating@example.test";
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.63" });
  await makePlan(page);
  await page.goto("/profiles");
  await page.getByRole("button", { name: "Save my profile" }).click();
  await signUpInSheet(page, email);
  await finishProfile(page);
  await expect(page).toHaveURL(/\/profiles$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("You are signed up. Repeat saving your profile from this page.");
  expect(await withDb((db) => db.select().from(s.authUsers).where(and(eq(s.authUsers.email, email), eq(s.authUsers.emailVerified, true))))).toHaveLength(1);
});

test("anonymous rating: rate 4, sign up, and the rating is saved on the recipe", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.67" });
  await page.goto("/recipes/tofu-burrito-bowl");
  await page.getByRole("radio", { name: "4", exact: true }).click();
  await signUpInSheet(page, "gate-rate-four@example.test");
  await finishProfile(page);
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("Saved. You rated this recipe 4 out of 5.");
  await page.reload();
  await expect(page.getByRole("radio", { name: "4", exact: true })).toBeChecked();
  expect(await deviceKeys(page)).toEqual({ session: [], local: [] });
});

test("anonymous ban: hide a recipe, sign up, and it stays hidden", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.68" });
  await page.goto("/recipes/tofu-burrito-bowl");
  await page.getByRole("button", { name: "Never suggest this" }).click();
  await page.getByRole("button", { name: "Yes, hide it" }).click();
  await signUpInSheet(page, "gate-ban@example.test");
  await finishProfile(page);
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("Saved. This recipe is hidden from your plans.");
  await page.reload();
  await expect(page.getByRole("button", { name: "Allow this recipe again" })).toBeVisible();
});

test("anonymous cooked: mark a recipe as cooked, sign up, and it stays marked", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.69" });
  await page.goto("/recipes/tofu-burrito-bowl");
  await page.getByRole("button", { name: "Cooked and tested", exact: true }).click();
  await signUpInSheet(page, "gate-tested@example.test");
  await finishProfile(page);
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/, { timeout: 60_000 });
  await expect(page.getByTestId("replay-notice")).toContainText("Saved. This recipe is marked as cooked.");
  await page.reload();
  await expect(page.getByRole("button", { name: "Cooked and tested", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a visitor's device profile prefills onboarding and is cleared after the save when no action is waiting", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.70" });
  await page.goto("/profiles");
  await page.evaluate(() => sessionStorage.setItem("pk-anon-profile", JSON.stringify({ version: 1, name: "Asha", protein: { mode: "fixed", grams: 90 } })));
  await page.reload();
  await page.getByRole("button", { name: "Save my profile" }).click();
  // No action should be waiting, so the form itself is responsible for clearing the device copy.
  await page.evaluate(() => { for (const store of [sessionStorage, localStorage]) store.removeItem("pk-pending-intent"); });
  await signUpInSheet(page, "gate-prefill@example.test");
  await expect(page.getByText("We filled in what you entered on this device.")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Asha");
  await expect(page.getByRole("radio", { name: "Fixed grams", exact: true })).toBeChecked();
  await expect(page.getByLabel("Protein (g per day)", { exact: true })).toHaveValue("90");
  await expect(page.getByLabel("Date of birth")).toHaveValue("");
  await expect(page.getByLabel("Height (cm)")).toHaveValue("");
  await page.getByLabel("Date of birth").fill("2000-01-01");
  await page.getByLabel("Height (cm)").fill("170");
  await page.getByLabel("Weight (kg)").fill("70");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 60_000 });
  expect(await deviceKeys(page)).toEqual({ session: [], local: [] });
});

test("the anonymous plan survives reopening the page and is cleared once it is imported", async ({ page }) => {
  test.setTimeout(240_000);
  const email = "gate-clear@example.test";
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.64" });
  await makePlan(page);
  const planned = await overview(page);

  await page.reload();
  await expect(page.getByText("This plan is on this device only")).toBeVisible();
  expect(await overview(page)).toBe(planned);

  await page.goto("/plan");
  await expect(page.getByText("Your plan is on this device")).toBeVisible();
  await page.getByRole("link", { name: "Open plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/draft$/);

  // The list is built from the same device plan; ticking stays on the device and the pantry asks for an account.
  await page.goto("/groceries");
  await expect(page.getByText("Ticks stay on this device")).toBeVisible();
  const firstTick = page.locator("main section ul input[type=checkbox]").first();
  await firstTick.check();
  await page.reload();
  await expect(page.locator("main section ul input[type=checkbox]").first()).toBeChecked();
  await page.getByLabel("Add an item").fill("Dish soap");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog", { name: SHEET })).toBeVisible();
  await page.getByRole("button", { name: "Close Create your account to continue" }).click();

  await page.goto("/plan/draft");
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await signUpInSheet(page, email);
  await finishProfile(page);
  await expect(page).toHaveURL(/\/plan\/\d+$/, { timeout: 60_000 });
  expect(await deviceKeys(page)).toEqual({ session: [], local: [] });

  await page.goto("/plan/draft");
  await expect(page.getByTestId("draft-state")).toContainText("No plan on this device");
});

test("draft page explains an expired or damaged plan and offers a restart", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.65" });
  await makePlan(page);
  const raw = await page.evaluate(() => sessionStorage.getItem("pk-anon-draft")!);
  await page.evaluate((value) => {
    const d = JSON.parse(value) as { createdAt: string };
    d.createdAt = new Date(Date.now() - 15 * 86_400_000).toISOString();
    sessionStorage.setItem("pk-anon-draft", JSON.stringify(d));
  }, raw);
  await page.reload();
  await expect(page.getByTestId("draft-state")).toContainText("This plan expired");
  await expect(page.getByRole("link", { name: "Make a new plan" })).toHaveAttribute("href", "/plan/new");

  await page.evaluate(() => sessionStorage.setItem("pk-anon-draft", "{not json"));
  await page.reload();
  await expect(page.getByTestId("draft-state")).toContainText("could not be read");

  await page.evaluate(() => sessionStorage.setItem("pk-anon-draft", JSON.stringify({ version: 99 })));
  await page.reload();
  await expect(page.getByTestId("draft-state")).toContainText("older version");
});

test("at 390 px the setup, draft, groceries and signup sheet fit with 44 px tap targets", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.66" });
  await page.goto("/plan/new");
  await expect(page.getByLabel("Weight, kg")).toBeVisible();
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[class*=min-h], main input, main select")).toEqual([]);
  await makePlan(page);
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[class*=min-h]")).toEqual([]);
  await page.screenshot({ path: "test-results/anonymous-draft-phone.png", fullPage: true });
  await page.goto("/groceries");
  await expect(page.getByText("Ticks stay on this device")).toBeVisible();
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[class*=min-h], main input")).toEqual([]);
  await page.goto("/profiles");
  await expect(page.getByRole("button", { name: "Save my profile" })).toBeVisible();
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[class*=min-h]")).toEqual([]);
  await page.getByRole("button", { name: "Save my profile" }).click();
  const dialog = page.getByRole("dialog", { name: SHEET });
  await expect(dialog.getByLabel("Email", { exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "dialog button, dialog input, dialog a")).toEqual([]);
  await page.screenshot({ path: "test-results/anonymous-signup-sheet-phone.png" });
});
