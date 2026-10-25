import { expect, test as anonymous } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { testMailPath } from "../../lib/auth/test-mail";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { noHorizontalScroll, smallTargets } from "./layout";
import { test as member } from "./member-fixture";
import { e2eTarget } from "./target";

anonymous("a signed-in person who has not finished their profile sees Sign out, not Create account", async ({ page }) => {
  anonymous.setTimeout(120_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const email = `shell-${randomUUID()}@example.test`;
  let userId: string | undefined;
  let householdId: string | undefined;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.94" });
    await page.goto("/sign-up");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Check your email to continue");
    const mail = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in"), "utf8")));
    await page.getByLabel("Six-digit email code").fill(mail.otp);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    const [user] = await handle.db.select().from(s.authUsers).where(eq(s.authUsers.email, email));
    userId = user!.id;
    const [row] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    householdId = row!.householdId!;

    // Desktop: the account group offers finishing setup and signing out, never sign-up again.
    const group = page.getByRole("group", { name: "Account" });
    await expect(group.getByRole("link", { name: "Finish setting up", exact: true })).toHaveAttribute("href", "/onboarding");
    await expect(group.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(group.getByRole("link", { name: "Create account" })).toHaveCount(0);
    await expect(group.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);

    // Phone: the header carries Sign out and no sign-in link.
    await page.setViewportSize({ width: 375, height: 812 });
    const header = page.locator("header");
    await expect(header.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: /Sign in|Create account/ })).toHaveCount(0);
    await noHorizontalScroll(page);

    await header.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in/);

    // Sign back in, finish the profile: the shell becomes the member shell.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Check your email to continue");
    const again = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in"), "utf8")));
    await page.getByLabel("Six-digit email code").fill(again.otp);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Synthetic shell profile");
    await page.getByLabel("Date of birth").fill("2000-01-01");
    await page.getByLabel("Height (cm)").fill("170");
    await page.getByLabel("Weight (kg)").fill("70");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page).not.toHaveURL(/\/onboarding/);
    await expect(page.getByRole("link", { name: "Your account", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Account" })).toHaveCount(0);
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

anonymous("sign-in and sign-up do not mention invitations or household keys", async ({ page }) => {
  for (const url of ["/sign-in", "/sign-up"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Sign in or create an account", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/invitation|household key/i);
    await page.getByRole("button", { name: "Email me a link instead" }).click();
    await expect(page.locator("main")).not.toContainText(/invitation|household key/i);
  }
});

for (const width of [320, 375, 390]) {
  member(`a member's shell fits at ${width} px with a compact header and 44 px targets`, async ({ page }) => {
    member.setTimeout(120_000);
    await page.setViewportSize({ width, height: 800 });
    for (const url of ["/", "/recipes", "/groceries", "/account", "/settings"]) {
      await page.goto(url);
      const header = page.locator("header");
      await expect(header.getByRole("link", { name: "Account", exact: true })).toBeVisible();
      await expect(header.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
      await noHorizontalScroll(page);
      // The row is h-14; the header adds a 1 px bottom border on top of it.
      const box = await header.locator("> div").boundingBox();
      expect(box?.height ?? 0, url).toBeLessThanOrEqual(56);
      expect(await smallTargets(page, "header a, header button, nav[aria-label=Main] a, main a[class*=min-h], main button"), url).toEqual([]);
    }
  });
}

member("settings holds the colour theme control for members", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  const theme = page.getByRole("radiogroup", { name: "Colour theme" });
  await expect(theme).toBeVisible();
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await theme.getByRole("radio", { name: "Auto" }).click();
});
