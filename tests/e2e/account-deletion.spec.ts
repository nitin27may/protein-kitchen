import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { testMailPath } from "../../lib/auth/test-mail";
import { e2eTarget } from "./target";

async function mailedCode(email: string, type: "sign-in" | "email-verification") {
  return z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, type), "utf8"))).otp;
}
async function signInByCode(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email to continue");
  await page.getByLabel("Six-digit email code").fill(await mailedCode(email, "sign-in"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

test("the privacy page is public and linked from the sign-in form", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.95" });
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "How we use your email", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy", exact: true })).toBeVisible();
  for (const name of ["What we store", "On this device", "How your email address is used", "Where your data is held", "Backups", "Download your data", "Delete your account", "Contact"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
});

test("a passwordless sole owner deletes the account and household with an email code, and signing in again starts a fresh kitchen", async ({ page, context }) => {
  test.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const email = `deletion-${randomUUID()}@example.test`;
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.96" });
    await signInByCode(page, email);
    const [user] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    const [member] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, user!.id));
    const firstHousehold = member!.householdId!;
    await page.getByLabel("Name", { exact: true }).fill("Synthetic deletion profile");
    await page.getByLabel("Date of birth").fill("1985-03-04");
    await page.getByLabel("Height (cm)").fill("183");
    await page.getByLabel("Weight (kg)").fill("93");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page).not.toHaveURL(/\/onboarding/);
    await page.goto("/account");
    await expect(page.getByRole("link", { name: "How we use your data", exact: true })).toBeVisible();
    expect((await handle.db.select().from(s.authAccounts).where(eq(s.authAccounts.userId, user!.id))).filter((row) => row.password)).toEqual([]);

    await page.getByRole("button", { name: "Delete my account", exact: true }).click();
    await expect(page.getByText("You are the only member of this household", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`We sent a six-digit code to ${email}`);
    const submit = page.getByRole("button", { name: "Permanently delete my account", exact: true });
    await expect(submit).toBeDisabled();
    const code = await mailedCode(email, "email-verification");
    await page.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await page.getByLabel("Six-digit email code", { exact: true }).fill(code === "000000" ? "111111" : "000000");
    await submit.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("not valid");
    expect(await handle.db.select().from(s.households).where(eq(s.households.id, firstHousehold))).toHaveLength(1);
    await page.screenshot({ path: "test-results/account-deletion-code-phone.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
    const stale = await context.cookies();

    await page.getByLabel("Six-digit email code", { exact: true }).fill(code);
    await submit.click();
    await expect(page).toHaveURL(/\/account-deleted$/);
    await expect(page.getByRole("heading", { level: 1, name: "Your account has been deleted", exact: true })).toBeVisible();

    expect(await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email))).toEqual([]);
    expect(await handle.db.select().from(s.households).where(eq(s.households.id, firstHousehold))).toEqual([]);
    expect(await handle.db.select().from(s.people).where(eq(s.people.householdId, firstHousehold))).toEqual([]);
    await context.addCookies(stale);
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    await context.clearCookies();

    await signInByCode(page, email);
    const [fresh] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    expect(fresh!.id).not.toBe(user!.id);
    const [freshMember] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, fresh!.id));
    expect(freshMember).toMatchObject({ role: "owner", personId: null });
    expect(freshMember!.householdId).not.toBe(firstHousehold);
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
  } finally {
    const [leftover] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    if (leftover) {
      const memberships = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, leftover.id));
      await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, leftover.id));
      for (const { householdId } of memberships) {
        if (!householdId) continue;
        await handle.db.delete(s.people).where(eq(s.people.householdId, householdId));
        await handle.db.delete(s.households).where(eq(s.households.id, householdId));
      }
      await handle.db.delete(s.authUsers).where(eq(s.authUsers.id, leftover.id));
    }
    await handle.close();
  }
});
