import { expect, test } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { e2eTarget } from "./target";

test("verified account creates an empty household without a grant, retries failure and completes its own profile", async ({ page }) => {
  test.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const userId = randomUUID();
  const email = `creation-${userId}@example.test`;
  const password = "Synthetic-household-creation-password-123!";
  let householdId: string | undefined;
  let releaseScripts = () => {};
  try {
    await handle.db.insert(s.authUsers).values({ id: userId, email, name: "Synthetic new cook", emailVerified: true });
    await handle.db.insert(s.authAccounts).values({
      id: randomUUID(), userId, providerId: "credential", accountId: userId, password: await hashPassword(password),
    });
    const existingHouseholds = await handle.db.select().from(s.households);
    const existingProfiles = await handle.db.select().from(s.people);
    const existingPlans = await handle.db.select().from(s.plans);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.93" });
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding(?:\?|$)/);
    const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
    await page.route("**/_next/static/**", async (route) => {
      if (route.request().resourceType() === "script") await scriptsReady;
      await route.continue();
    });
    await page.reload({ waitUntil: "commit" });
    const create = page.getByRole("button", { name: "Create household", exact: true });
    await expect(create).toBeVisible();
    await expect(create).toBeDisabled();
    releaseScripts();
    await expect(create).toBeEnabled();
    await page.unroute("**/_next/static/**");
    await page.getByLabel("Household name", { exact: true }).fill("   ");
    await create.click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "Check the marked fields" })).toBeVisible();
    await expect(page.getByText("Enter a household name.", { exact: true })).toBeVisible();
    expect(await handle.db.select().from(s.households)).toEqual(existingHouseholds);
    await page.getByLabel("Household name", { exact: true }).fill("  Synthetic code-free household  ");
    await page.route("**/onboarding*", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
    await create.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Your household could not be created");
    await expect(page.getByLabel("Household name", { exact: true })).toHaveValue("  Synthetic code-free household  ");
    expect(await handle.db.select().from(s.households)).toEqual(existingHouseholds);
    await page.unroute("**/onboarding*");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/household-creation-phone.png", fullPage: true });
    const outgoing = page.waitForRequest((request) => request.method() === "POST" && !!request.headers()["next-action"]);
    await create.click();
    const submitted = await outgoing;
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    const [member] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    expect(member).toMatchObject({ role: "owner", personId: null });
    householdId = member!.householdId!;
    expect(await handle.db.select().from(s.households).where(eq(s.households.id, householdId)))
      .toMatchObject([{ name: "Synthetic code-free household" }]);
    expect(await handle.db.select().from(s.authSessions).where(eq(s.authSessions.userId, userId)))
      .toMatchObject([{ activeHouseholdId: householdId }]);
    expect(await handle.db.select().from(s.people)).toEqual(existingProfiles);
    expect(await handle.db.select().from(s.plans)).toEqual(existingPlans);
    const replay = await page.request.post("/onboarding", {
      headers: {
        origin: "http://127.0.0.1:3112", "next-action": submitted.headers()["next-action"]!,
        "content-type": submitted.headers()["content-type"]!,
      },
      data: submitted.postData()!,
    });
    expect(await replay.text()).toContain("already has a household membership");
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
    await expect(page.getByRole("button", { name: "Create household", exact: true })).toHaveCount(0);
    expect(await handle.db.select().from(s.people).where(eq(s.people.householdId, householdId)))
      .toMatchObject([{ name: "Synthetic new household profile" }]);
    for (const profile of existingProfiles) {
      expect(await handle.db.select().from(s.people).where(eq(s.people.id, profile.id))).toEqual([profile]);
    }
    expect(await handle.db.select().from(s.plans)).toEqual(existingPlans);
  } finally {
    releaseScripts();
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    if (householdId) {
      await handle.db.delete(s.people).where(eq(s.people.householdId, householdId));
      await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    }
    await handle.db.delete(s.authUsers).where(eq(s.authUsers.id, userId));
    await handle.close();
  }
});
