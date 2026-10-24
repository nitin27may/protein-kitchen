import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { testMailPath } from "../../lib/auth/test-mail";

const password = "Synthetic-ui-password-for-tests-123!";
const owner = "ui-owner@example.test";
const cook = "ui-cook@example.test";
const bootstrap = "synthetic-browser-bootstrap-key-for-tests";
async function code(email: string, type: "email-verification" | "sign-in" | "forget-password") {
  return z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, type), "utf8"))).otp;
}
async function signup(page: Page, email: string, grant: string, firstOwner = false) {
  await page.goto("/sign-up");
  await page.getByLabel("Account name", { exact: true }).fill(firstOwner ? "Synthetic UI owner" : "Synthetic UI cook");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  if (firstOwner) await page.getByRole("radio", { name: "First owner", exact: true }).click();
  await page.getByLabel(firstOwner ? "Household bootstrap key" : "Invitation code", { exact: true }).fill(grant);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify your email", exact: true })).toBeVisible();
  if (firstOwner) {
    const original = await code(email, "email-verification");
    await page.getByLabel("Six-digit email code").fill(original === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Verify email", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByRole("status")).toContainText("it has been sent");
  }
  await page.getByLabel("Six-digit email code").fill(await code(email, "email-verification"));
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Email verified");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}
async function join(page: Page, grant: string, firstOwner = false) {
  if (firstOwner) await page.getByRole("radio", { name: "First owner", exact: true }).click();
  await page.getByLabel(firstOwner ? "Household bootstrap key" : "Invitation code", { exact: true }).fill(grant);
  await page.getByRole("button", { name: "Join household", exact: true }).click();
}
async function signIn(page: Page, email: string, secret: string) {
  await page.goto("/sign-in?next=%2Faccount");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test("owner and invited cook finish UI onboarding, keep separate profiles and share plan, shopping and prep", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.21" });
  await signup(page, owner, bootstrap, true);
  await page.reload();
  await join(page, bootstrap, true);
  await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Synthetic owner targets");
  await page.getByLabel("Date of birth").fill("2000-01-01");
  await page.getByLabel("Height (cm)").fill("170");
  await page.getByLabel("Weight (kg)").fill("70");
  await page.getByRole("radio", { name: "Fixed grams", exact: true }).click();
  await page.getByLabel("Protein (g per day)", { exact: true }).fill("95");
  await page.route("**/onboarding*", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("profile could not be saved");
  await page.unroute("**/onboarding*");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3112/");
  await page.goto("/account");
  await expect(page.getByRole("link", { name: "Profile: Synthetic owner targets" })).toBeVisible();
  const ownerProfile = await page.getByRole("link", { name: "Profile: Synthetic owner targets" }).getAttribute("href");
  expect(ownerProfile).toMatch(/^\/profiles\/\d+$/);
  await page.getByLabel("Cook's email").fill(cook);
  await page.getByLabel("Reserve an existing profile (optional)").selectOption("300");
  await page.getByRole("button", { name: "Create invitation code" }).click();
  const grant = await page.getByTestId("invitation-code").innerText();
  expect(grant).toMatch(/^[\w-]{43}$/);
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "127.0.0.22" } });
  try {
    const second = await other.newPage();
    await signup(second, cook, grant);
    await page.getByRole("button", { name: "Revoke invitation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Revoke invitation", exact: true })).toHaveCount(0);
    await join(second, grant);
    await expect(second.getByRole("main").getByRole("alert")).toContainText("invalid or no longer available");
    await page.getByRole("button", { name: "Create invitation code" }).click();
    const replacementGrant = await page.getByTestId("invitation-code").innerText();
    expect(replacementGrant).not.toBe(grant);
    await join(second, replacementGrant);
    await expect(second).toHaveURL("http://127.0.0.1:3112/");
    await second.goto("/account");
    await expect(second.getByRole("link", { name: "Profile: Synthetic import fixture" })).toBeVisible();
    await expect(second.getByRole("heading", { name: "Invite another cook" })).toHaveCount(0);
    await second.goto("/profiles");
    await expect(second.getByRole("link", { name: "Add person", exact: true })).toHaveCount(0);
    await expect(second.getByRole("main")).not.toContainText("Synthetic owner targets");
    await second.goto(ownerProfile!);
    await expect(second).toHaveURL(/\/account$/);
    await second.goto("/profiles/new");
    await expect(second).toHaveURL(/\/account$/);
    const plan = `/plan/${process.env.E2E_PREP_PLAN_ID}`;
    await page.goto(plan);
    await second.goto(plan);
    const title = await page.getByRole("main").getByRole("heading", { level: 1 }).innerText();
    await expect(second.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(title);
    await page.goto("/groceries");
    const tick = page.getByRole("checkbox").first();
    const checked = await tick.isChecked();
    await tick.setChecked(!checked);
    await page.waitForLoadState("networkidle");
    await second.goto("/groceries");
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
    await second.goto(`${plan}/prep`);
    const prep = second.getByRole("checkbox").first();
    const done = await prep.isChecked();
    await prep.setChecked(!done);
    await second.waitForLoadState("networkidle");
    await page.goto(`${plan}/prep`);
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !done });
    await page.goto("/account");
    await page.reload();
    await expect(page.getByRole("link", { name: "Profile: Synthetic owner targets" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get(`/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`)).status()).toBe(401);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.getByLabel("Email", { exact: true }).fill(owner);
    await page.getByRole("button", { name: "Use an email code" }).click();
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(page.getByLabel("Six-digit email code")).toBeVisible();
    await page.getByLabel("Six-digit email code").fill(await code(owner, "sign-in"));
    await page.getByRole("button", { name: "Sign in with code", exact: true }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3112/");
    await page.goto("/reset-password");
    await page.getByLabel("Email", { exact: true }).fill(owner);
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(page.getByLabel("Six-digit email code")).toBeVisible();
    await page.getByLabel("Six-digit email code").fill(await code(owner, "forget-password"));
    const replacement = "Synthetic-ui-reset-password-456!";
    await page.getByLabel("New password", { exact: true }).fill(replacement);
    await page.getByRole("button", { name: "Update password", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Password updated");
    await signIn(page, owner, replacement);
    await second.goto("/account");
    await expect(second.getByRole("link", { name: "Profile: Synthetic import fixture" })).toBeVisible();
    expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
      .toEqual({ local: [], session: [] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/auth-account-phone.png", fullPage: true });
  } finally { await other.close(); }
});

test("signup and sign-in show actionable failures and support retry without storing secrets", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.23" });
  await page.goto("/sign-up");
  await page.getByLabel("Account name", { exact: true }).fill("Synthetic uninvited");
  await page.getByLabel("Email", { exact: true }).fill("ui-outsider@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Invitation code", { exact: true }).fill("invalid");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Signup requires");
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("ui-outsider@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.route("**/api/auth/sign-in/email", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Check your connection");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.unroute("**/api/auth/sign-in/email");
  await page.route("**/api/auth/sign-in/email", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"message":"Authentication is not configured on this instance."}',
  }));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("not configured");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
