import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { testMailPath } from "../../lib/auth/test-mail";
import { e2eTarget } from "./target";

test("a new person signs up by email code, gets a kitchen with no household form, and completes their own profile", async ({ page }) => {
  test.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const email = `creation-${randomUUID()}@example.test`;
  let userId: string | undefined;
  let householdId: string | undefined;
  try {
    const existingHouseholds = await handle.db.select().from(s.households);
    const existingProfiles = await handle.db.select().from(s.people);
    const existingPlans = await handle.db.select().from(s.plans);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.93" });
    await page.goto("/sign-up");
    await expect(page.getByRole("heading", { name: "Sign in or create an account", exact: true })).toBeVisible();
    await expect(page.getByLabel("Invitation code")).toHaveCount(0);
    await expect(page.getByLabel("Household name")).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/signup-phone.png", fullPage: true });
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Check your email to continue");
    const mail = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in"), "utf8")));
    await page.getByLabel("Six-digit email code").fill(mail.otp);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create household", exact: true })).toHaveCount(0);
    const [user] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    userId = user!.id;
    expect(user).toMatchObject({ emailVerified: true });
    const [member] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    expect(member).toMatchObject({ role: "owner", personId: null });
    householdId = member!.householdId!;
    expect(existingHouseholds.map((household) => household.id)).not.toContain(householdId);
    expect(await handle.db.select().from(s.households).where(eq(s.households.id, householdId)))
      .toMatchObject([{ name: `${email.split("@")[0]}'s kitchen` }]);
    expect(await handle.db.select().from(s.authSessions).where(eq(s.authSessions.userId, userId)))
      .toMatchObject([{ activeHouseholdId: householdId }]);
    expect(await handle.db.select().from(s.people)).toEqual(existingProfiles);
    expect(await handle.db.select().from(s.plans)).toEqual(existingPlans);
    await page.reload();
    expect(await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId))).toHaveLength(1);
    await page.getByLabel("Name", { exact: true }).fill("Synthetic new household profile");
    await page.getByLabel("Date of birth").fill("2000-01-01");
    await page.getByLabel("Height (cm)").fill("170");
    await page.getByLabel("Weight (kg)").fill("70");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page).not.toHaveURL(/\/onboarding/);
    await page.goto("/account");
    await page.reload();
    await expect(page.getByRole("link", { name: "Profile: Synthetic new household profile", exact: true })).toBeVisible();
    expect(await handle.db.select().from(s.people).where(eq(s.people.householdId, householdId)))
      .toMatchObject([{ name: "Synthetic new household profile" }]);
    for (const profile of existingProfiles) {
      expect(await handle.db.select().from(s.people).where(eq(s.people.id, profile.id))).toEqual([profile]);
    }
    expect(await handle.db.select().from(s.plans)).toEqual(existingPlans);
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
