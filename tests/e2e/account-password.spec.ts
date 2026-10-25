import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { testMailPath } from "../../lib/auth/test-mail";
import { e2eTarget } from "./target";

const password = "Synthetic-browser-set-password-1!";
const changed = "Synthetic-browser-changed-password-2!";

async function expectTapTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function passwordSignIn(page: Page, email: string, value: string) {
  await page.goto("/sign-in?next=%2Faccount");
  await page.getByRole("button", { name: "I have a password", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("a code-created account sets, uses and changes a password and renames its household at phone width", async ({ page }) => {
  test.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const email = `password-${randomUUID()}@example.test`;
  let userId: string | undefined;
  let householdId: string | undefined;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.97" });
    await page.goto("/sign-up");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Check your email to continue");
    const mail = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in"), "utf8")));
    await page.getByLabel("Six-digit email code").fill(mail.otp);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Synthetic password profile");
    await page.getByLabel("Date of birth").fill("2000-01-01");
    await page.getByLabel("Height (cm)").fill("170");
    await page.getByLabel("Weight (kg)").fill("70");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page).not.toHaveURL(/\/onboarding/);
    const [user] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    userId = user!.id;
    householdId = (await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId)))[0]!.householdId!;

    // No password yet: only the set form is offered and password sign-in is refused.
    await page.goto("/account");
    await expect(page.getByRole("button", { name: "Change password", exact: true })).toHaveCount(0);
    const setButton = page.getByRole("button", { name: "Set a password", exact: true });
    await expectTapTarget(setButton);
    await setButton.click();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveCount(0);
    await expectNoOverflow(page);
    await page.screenshot({ path: "test-results/account-password-phone.png", fullPage: true });

    await page.getByLabel("New password", { exact: true }).fill("short-pass1");
    await page.getByLabel("Confirm new password", { exact: true }).fill("short-pass1");
    await expectTapTarget(page.getByRole("button", { name: "Save password", exact: true }));
    await page.getByRole("button", { name: "Save password", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Use 12 to 128 characters");
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password", { exact: true }).fill(`${password}x`);
    await page.getByRole("button", { name: "Save password", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("do not match");
    expect(await handle.db.select().from(s.authAccounts).where(eq(s.authAccounts.userId, userId))).toEqual([]);

    await page.getByLabel("Confirm new password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Save password", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password set" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set a password", exact: true })).toHaveCount(0);
    expect(await handle.db.select().from(s.authAccounts).where(eq(s.authAccounts.userId, userId)))
      .toMatchObject([{ providerId: "credential", password: expect.not.stringContaining(password) }]);

    // The new password signs in from a signed-out browser state.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await passwordSignIn(page, email, "Synthetic-wrong-password-9!");
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await passwordSignIn(page, email, password);
    await expect(page).toHaveURL(/\/account$/);

    // Change requires the current password.
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await page.getByLabel("Current password", { exact: true }).first().fill("Synthetic-wrong-password-9!");
    await page.getByLabel("New password", { exact: true }).fill(changed);
    await page.getByLabel("Confirm new password", { exact: true }).fill(changed);
    await page.getByRole("button", { name: "Save new password", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("current password is not correct");
    await page.getByLabel("Current password", { exact: true }).first().fill(password);
    await page.getByRole("button", { name: "Save new password", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Change password", exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await passwordSignIn(page, email, password);
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await passwordSignIn(page, email, changed);
    await expect(page).toHaveURL(/\/account$/);

    // Household rename on /households.
    await page.goto("/households");
    const rename = page.getByRole("button", { name: /^Rename household:/ });
    await expectTapTarget(rename);
    await rename.click();
    await page.getByLabel("Household name", { exact: true }).fill("   ");
    await expect(page.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
    await page.getByLabel("Household name", { exact: true }).fill("Synthetic renamed kitchen");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.getByText("Household renamed.")).toBeVisible();
    await expect(page.getByText("Synthetic renamed kitchen")).toBeVisible();
    expect(await handle.db.select().from(s.households).where(eq(s.households.id, householdId)))
      .toMatchObject([{ name: "Synthetic renamed kitchen" }]);
    await expectNoOverflow(page);
  } finally {
    if (userId) await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    if (householdId) {
      await handle.db.delete(s.people).where(eq(s.people.householdId, householdId));
      await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    }
    if (userId) await handle.db.delete(s.authUsers).where(eq(s.authUsers.id, userId));
    await handle.close();
  }
});
