import { expect, test } from "./member-fixture";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { testMailPath } from "../../lib/auth/test-mail";
import { e2eTarget } from "./target";

test("owner adds/revokes by email; verified recipients can accept or decline without pre-acceptance details", async ({ page, browser }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const ownerEmail = "authorized-browser-fixture@example.test";
  const acceptedEmail = `association-${randomUUID()}@example.test`;
  const declinedEmail = `decline-${randomUUID()}@example.test`;
  const acceptedUserId = randomUUID();
  const declinedUserId = randomUUID();
  const declinedHouseholdId = randomUUID();
  const password = "Synthetic-association-password-123!";
  const created = new Date();
  try {
    const [owner] = await handle.db.select({ userId: s.householdMembers.userId, householdId: s.householdMembers.householdId })
      .from(s.householdMembers).innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId))
      .where(eq(s.authUsers.email, ownerEmail));
    expect(owner?.householdId).toBeTruthy();
    const targetHouseholdId = owner!.householdId!;
    for (const [email, id] of [[acceptedEmail, acceptedUserId], [declinedEmail, declinedUserId]] as const) {
      await handle.db.insert(s.authUsers).values({ id, email, name: "Synthetic recipient", emailVerified: true });
      await handle.db.insert(s.authAccounts).values({
        id: randomUUID(), userId: id, providerId: "credential", accountId: id, password: await hashPassword(password),
      });
    }
    await handle.db.insert(s.households).values({ id: declinedHouseholdId, name: "Existing recipient household" });
    await handle.db.insert(s.householdMembers).values({
      householdId: declinedHouseholdId, userId: declinedUserId, role: "owner", personId: null,
    });
    const selectionBefore = await handle.db.select({ activeHouseholdId: s.authSessions.activeHouseholdId })
      .from(s.authSessions).where(eq(s.authSessions.userId, owner!.userId));

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Add a household member by email", exact: true })).toBeVisible();
    await page.getByLabel("Member's email", { exact: true }).fill(acceptedEmail);
    await page.getByLabel("Display name (optional)", { exact: true }).fill("Pat");
    await page.getByLabel("Relationship (optional)", { exact: true }).selectOption("partner");
    await page.getByRole("button", { name: "Add email association", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("notification email sent");
    const [first] = await handle.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, acceptedEmail));
    expect(first).toMatchObject({
      householdId: targetHouseholdId, tokenHash: null, displayName: "Pat", relationship: "partner",
    });
    const notice = z.object({ type: z.literal("household-association"), email: z.literal(acceptedEmail), url: z.string().url() })
      .parse(JSON.parse(await readFile(testMailPath(acceptedEmail, "household-association"), "utf8")));
    expect(notice.url).toBe("http://127.0.0.1:3112/sign-in");
    await expect(page.getByText(acceptedEmail, { exact: false })).toBeVisible();
    const acceptedAssociation = page.getByText(acceptedEmail, { exact: false }).locator("xpath=..");
    await acceptedAssociation.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText(acceptedEmail, { exact: false })).toHaveCount(0);
    expect((await handle.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, first!.id)))[0]?.revokedAt).toBeTruthy();

    await page.getByLabel("Member's email", { exact: true }).fill(acceptedEmail);
    await page.getByLabel("Display name (optional)", { exact: true }).fill("");
    await page.getByLabel("Relationship (optional)", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Add email association", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("notification email sent");

    const acceptedContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "127.0.0.91" } });
    const declinedContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "127.0.0.92" } });
    try {
      const accepted = await acceptedContext.newPage();
      await accepted.goto("http://127.0.0.1:3112/sign-in");
      await accepted.getByLabel("Email", { exact: true }).fill(acceptedEmail);
      await accepted.getByLabel("Password", { exact: true }).fill(password);
      await accepted.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(accepted).toHaveURL(/\/onboarding(?:\?|$)/);
      await expect(accepted.getByRole("heading", { name: "Household email association", exact: true })).toBeVisible();
      await expect(accepted.getByText("Pat", { exact: true })).toHaveCount(0);
      await expect(accepted.getByText("Synthetic authorized fixture", { exact: true })).toHaveCount(0);
      await accepted.getByRole("button", { name: "Accept and join", exact: true }).click();
      await expect(accepted.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
      const [acceptedMember] = await handle.db.select().from(s.householdMembers)
        .where(eq(s.householdMembers.userId, acceptedUserId));
      expect(acceptedMember).toMatchObject({ householdId: targetHouseholdId, role: "member", personId: null });
      const [acceptedSession] = await handle.db.select().from(s.authSessions)
        .where(eq(s.authSessions.userId, acceptedUserId));
      expect(acceptedSession?.activeHouseholdId).toBe(targetHouseholdId);

      await page.getByLabel("Member's email", { exact: true }).fill(declinedEmail);
      await page.getByRole("button", { name: "Add email association", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("notification email sent");
      const declined = await declinedContext.newPage();
      await declined.goto("http://127.0.0.1:3112/sign-in");
      await declined.getByLabel("Email", { exact: true }).fill(declinedEmail);
      await declined.getByLabel("Password", { exact: true }).fill(password);
      await declined.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(declined).toHaveURL(/\/onboarding(?:\?|$)/);
      await expect(declined.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
      await expect(declined.getByRole("heading", { name: "Household email association", exact: true })).toBeVisible();
      await declined.getByRole("button", { name: "Decline", exact: true }).click();
      await expect(declined.getByRole("heading", { name: "Household email association", exact: true })).toHaveCount(0);
      const [declinedRow] = await handle.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.email, declinedEmail));
      expect(declinedRow?.declinedAt).toBeTruthy();
      expect(await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, declinedUserId)))
        .toMatchObject([{ householdId: declinedHouseholdId, role: "owner", personId: null }]);
    } finally {
      await acceptedContext.close();
      await declinedContext.close();
    }
    expect(await handle.db.select({ activeHouseholdId: s.authSessions.activeHouseholdId })
      .from(s.authSessions).where(eq(s.authSessions.userId, owner!.userId))).toEqual(selectionBefore);
  } finally { await handle.close(); }
});
