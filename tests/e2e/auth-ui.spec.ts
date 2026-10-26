import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { testMailPath } from "../../lib/auth/test-mail";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { issueInvitation } from "../../lib/auth/household";
import { e2eTarget } from "./target";

const password = "Synthetic-ui-password-for-tests-123!";
const owner = "ui-owner@example.test";
const cook = "ui-cook@example.test";
async function code(email: string, type: "email-verification" | "sign-in" | "forget-password") {
  return z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(email, type), "utf8"))).otp;
}
/** Open signup: email, then the six-digit code, creates the account. An invitation link may ride along. */
async function signup(page: Page, email: string, options: { invite?: string; wrongCodeFirst?: boolean } = {}) {
  await page.goto(options.invite ? `/sign-in?invite=${options.invite}` : "/sign-up");
  await expect(page.getByRole("heading", { name: "Sign in or create an account", exact: true })).toBeVisible();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await expect(page.getByLabel(/bootstrap key/i)).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email to continue");
  if (options.wrongCodeFirst) {
    const original = await code(email, "sign-in");
    await page.getByLabel("Six-digit email code").fill(original === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByRole("status")).toContainText("Check your email to continue");
  }
  await page.getByLabel("Six-digit email code").fill(await code(email, "sign-in"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}
async function acceptInvite(page: Page) {
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
}
async function setPassword(page: Page, email: string, address: string) {
  const headers = { origin: "http://127.0.0.1:3112", "x-forwarded-for": address };
  expect((await page.request.post("/api/auth/email-otp/request-password-reset", { headers, data: { email } })).status()).toBe(200);
  const reset = await page.request.post("/api/auth/email-otp/reset-password", {
    headers, data: { email, otp: await code(email, "forget-password"), password },
  });
  expect(reset.status()).toBe(200);
}
/** One address runs a long journey here; the mail caps have their own spec (mail-caps.spec.ts), so reset the ledger mid-journey. */
async function resetMailLedger() {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try { await handle.db.delete(s.mailSends); } finally { await handle.close(); }
}
async function legacyInvitation(email: string, personId?: number) {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [account] = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers).where(eq(s.authUsers.email, owner));
    if (!account) throw new Error("Expected the synthetic owner account.");
    return (await issueInvitation(handle.db, account.id, { email, personId })).token;
  } finally { await handle.close(); }
}
async function signIn(page: Page, email: string, secret: string) {
  await page.goto("/sign-in?next=%2Faccount");
  await page.getByRole("button", { name: "I have a password", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function saveAction(page: Page, change: () => Promise<void>) {
  const pathname = new URL(page.url()).pathname;
  const saved = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === pathname);
  await change();
  const response = await saved;
  expect(response.status()).toBe(200);
}
async function saveFeedback(page: Page, change: () => Promise<void>) {
  await saveAction(page, change);
  await expect(page.getByRole("button", { name: "Favourite", exact: true })).toBeEnabled();
}
async function downloadAccount(page: Page) {
  const incoming = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my account", exact: true }).click();
  const download = await incoming;
  expect(download.suggestedFilename()).toBe("protein-kitchen-account.json");
  const path = await download.path();
  expect(path).toBeTruthy();
  const text = await readFile(path!, "utf8");
  const value = z.object({
    format: z.literal("protein-kitchen-account"), version: z.literal(1),
    account: z.object({ email: z.string() }), profile: z.object({ name: z.string(), proteinTargetG: z.number().nullable() }),
  }).parse(JSON.parse(text));
  return { value, text };
}

test("owner and invited cook finish UI onboarding, keep separate profiles and share plan, shopping and prep", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.21" });
  await signup(page, owner, { wrongCodeFirst: true });
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
  const ownerControls = page.getByRole("group", { name: "Cook Synthetic owner targets", exact: true });
  await ownerControls.getByRole("button", { name: "Make member", exact: true }).click();
  await ownerControls.getByRole("button", { name: "Confirm role change", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("at least one verified owner");
  await ownerControls.getByRole("button", { name: "Cancel", exact: true }).click();
  const grant = await legacyInvitation(cook, 300);
  await page.reload();
  expect(grant).toMatch(/^[\w-]{43}$/);
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "127.0.0.22" } });
  try {
    const second = await other.newPage();
    await signup(second, cook, { invite: grant });
    await expect(second.getByRole("heading", { name: "Join a household", exact: true })).toBeVisible();
    const cookInvitation = page.getByText(cook, { exact: false }).locator("xpath=..");
    await cookInvitation.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(cookInvitation).toHaveCount(0);
    await acceptInvite(second);
    await expect(second.getByRole("main").getByRole("alert")).toContainText("invalid or no longer available");
    const replacementGrant = await legacyInvitation(cook, 300);
    await page.reload();
    expect(replacementGrant).not.toBe(grant);
    await second.goto(`/onboarding?invite=${replacementGrant}`);
    await acceptInvite(second);
    await expect(second).toHaveURL("http://127.0.0.1:3112/");
    await second.goto("/account");
    await expect(second.getByRole("link", { name: "Profile: Synthetic import fixture" })).toBeVisible();
    await expect(second.getByRole("heading", { name: "Invite another cook" })).toHaveCount(0);
    await page.route("**/api/account/export", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Download my account", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Check your connection");
    await page.unroute("**/api/account/export");
    await page.route("**/api/account/export", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false}' }));
    await page.getByRole("button", { name: "Download my account", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("could not be downloaded");
    await page.unroute("**/api/account/export");
    await page.route("**/api/account/export", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Unavailable</h1>" }));
    await page.getByRole("button", { name: "Download my account", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("did not return an account file");
    await page.unroute("**/api/account/export");
    const ownFile = await downloadAccount(page);
    expect(ownFile.value.account.email).toBe(owner);
    expect(ownFile.value.profile).toEqual({ name: "Synthetic owner targets", proteinTargetG: 95 });
    expect(ownFile.text).not.toContain(cook);
    expect(ownFile.text).not.toContain("Synthetic import fixture");
    const otherFile = await downloadAccount(second);
    expect(otherFile.value.account.email).toBe(cook);
    expect(otherFile.value.profile.name).toBe("Synthetic import fixture");
    expect(otherFile.text).not.toContain(owner);
    expect(otherFile.text).not.toContain("Synthetic owner targets");
    expect(otherFile.text).not.toContain("synthetic-browser-bootstrap-key");
    expect(ownFile.text).not.toContain(replacementGrant);
    await second.goto("/profiles");
    await expect(second.getByRole("link", { name: "Add person", exact: true })).toHaveCount(0);
    await expect(second.getByRole("main")).not.toContainText("Synthetic owner targets");
    await second.goto(ownerProfile!);
    await expect(second).toHaveURL(/\/account$/);
    await second.goto("/profiles/new");
    await expect(second).toHaveURL(/\/account$/);
    await page.reload();
    const cookControls = page.getByRole("group", { name: "Cook Synthetic import fixture", exact: true });
    await cookControls.getByRole("button", { name: "Make owner", exact: true }).click();
    await cookControls.getByRole("button", { name: "Confirm role change", exact: true }).click();
    await expect(cookControls.getByRole("button", { name: "Make member", exact: true })).toBeVisible();
    await second.reload();
    await expect(second.getByRole("heading", { name: "Household cooks", exact: true })).toBeVisible();
    await cookControls.getByRole("button", { name: "Make member", exact: true }).click();
    await page.route("**/account", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
    await cookControls.getByRole("button", { name: "Confirm role change", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(cookControls.getByRole("button", { name: "Confirm role change", exact: true })).toBeEnabled();
    await page.unroute("**/account");
    await cookControls.getByRole("button", { name: "Confirm role change", exact: true }).click();
    await expect(cookControls.getByRole("button", { name: "Make owner", exact: true })).toBeVisible();
    await second.reload();
    await expect(second.getByRole("heading", { name: "Household cooks", exact: true })).toHaveCount(0);
    const recipe = "/recipes/tofu-burrito-bowl";
    await page.goto(recipe);
    await second.goto(recipe);
    const favourite = page.getByRole("button", { name: "Favourite", exact: true });
    const otherFavourite = second.getByRole("button", { name: "Favourite", exact: true });
    await expect(favourite).toHaveAttribute("aria-pressed", "false");
    await expect(otherFavourite).toHaveAttribute("aria-pressed", "false");
    await page.route("**/recipes/tofu-burrito-bowl", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
    await favourite.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("feedback could not be saved");
    await expect(favourite).toHaveAttribute("aria-pressed", "false");
    await page.unroute("**/recipes/tofu-burrito-bowl");
    await saveFeedback(page, () => favourite.click());
    await saveFeedback(page, () => page.getByRole("radio", { name: "5", exact: true }).click());
    await second.reload();
    await expect(otherFavourite).toHaveAttribute("aria-pressed", "false");
    await expect(second.getByRole("radio", { name: "5", exact: true })).toHaveAttribute("aria-checked", "false");
    await saveFeedback(second, () => second.getByRole("radio", { name: "2", exact: true }).click());
    await page.reload();
    await expect(favourite).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("radio", { name: "5", exact: true })).toHaveAttribute("aria-checked", "true");
    await saveFeedback(second, () => second.getByRole("button", { name: "Cooked and tested", exact: true }).click());
    await page.reload();
    await expect(page.getByRole("button", { name: "Cooked and tested", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("radio", { name: "5", exact: true })).toHaveAttribute("aria-checked", "true");
    await second.reload();
    await expect(second.getByRole("radio", { name: "2", exact: true })).toHaveAttribute("aria-checked", "true");
    await saveFeedback(page, () => page.getByRole("button", { name: "Clear your rating", exact: true }).click());
    await second.reload();
    await expect(second.getByRole("radio", { name: "2", exact: true })).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
    await page.screenshot({ path: "test-results/personal-feedback-phone.png", fullPage: true });
    await page.goto("/recipes?yours=favourites");
    await expect(page.getByRole("main").locator('a[href="/recipes/tofu-burrito-bowl"]')).toBeVisible();
    await second.goto("/recipes?yours=favourites");
    await expect(second.getByRole("main").locator('a[href="/recipes/tofu-burrito-bowl"]')).toHaveCount(0);
    const plan = `/plan/${process.env.E2E_PREP_PLAN_ID}`;
    await page.goto(plan);
    await second.goto(plan);
    const title = await page.getByRole("main").getByRole("heading", { level: 1 }).innerText();
    await expect(second.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(title);
    await page.goto("/groceries");
    const tick = page.getByRole("checkbox").first();
    const checked = await tick.isChecked();
    await saveAction(page, () => tick.setChecked(!checked));
    await second.goto("/groceries");
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
    await second.goto(`${plan}/prep`);
    const prep = second.getByRole("checkbox").first();
    const done = await prep.isChecked();
    await saveAction(second, () => prep.setChecked(!done));
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
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByLabel("Six-digit email code")).toBeVisible();
    await page.getByLabel("Six-digit email code").fill(await code(owner, "sign-in"));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3112/");
    await resetMailLedger();
    await page.goto("/reset-password");
    await page.getByLabel("Email", { exact: true }).fill(owner);
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
    await page.screenshot({ path: "test-results/auth-account-phone.png", fullPage: true });
    await cookControls.getByRole("button", { name: "Remove cook", exact: true }).click();
    await cookControls.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(cookControls).toHaveCount(0);
    await second.goto("/groceries");
    await expect(second).toHaveURL(/\/sign-in$/);
    expect((await other.request.get(`http://127.0.0.1:3112/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`)).status()).toBe(401);
    const removedDownload = await other.request.get("http://127.0.0.1:3112/api/account/export");
    expect(removedDownload.status()).toBe(401);
    expect(removedDownload.headers()["cache-control"]).toContain("no-store");
    await page.goto(plan);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(title);
    await page.goto("/groceries");
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
    await page.goto(`${plan}/prep`);
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !done });
  } finally { await other.close(); }
});

test("confirmed member and original-owner deletion preserve shared meals and deny stale sessions", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const replacement = "Synthetic-ui-reset-password-456!";
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.31" });
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, owner, replacement);
  await page.getByRole("button", { name: "Delete my account", exact: true }).click();
  await expect(page.getByText("Your unlinked meal profile", { exact: false })).toBeVisible();
  const submit = page.getByRole("button", { name: "Permanently delete my account", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Current password", { exact: true }).fill(replacement);
  await page.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("at least one verified owner");
  await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Cancel account deletion", exact: true }).click();
  await expect(page.getByLabel("Current password", { exact: true })).toHaveCount(0);
  const grant = await legacyInvitation(cook, 300);
  await setPassword(page, cook, "127.0.0.34");
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": "127.0.0.32" } });
  try {
    const second = await other.newPage();
    await second.goto(`/sign-in?invite=${grant}`);
    await second.getByRole("button", { name: "I have a password", exact: true }).click();
    await second.getByLabel("Email", { exact: true }).fill(cook);
    await second.getByLabel("Password", { exact: true }).fill(password);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(second).toHaveURL(/\/onboarding(?:\?|$)/);
    await acceptInvite(second);
    await expect(second).toHaveURL("http://127.0.0.1:3112/");
    await second.goto("/account");
    await second.getByRole("button", { name: "Delete my account", exact: true }).click();
    const memberSubmit = second.getByRole("button", { name: "Permanently delete my account", exact: true });
    await second.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await second.getByLabel("Current password", { exact: true }).fill("wrong-password");
    await memberSubmit.click();
    await expect(second.getByRole("main").getByRole("alert")).toContainText("current password is incorrect");
    await second.route("**/api/auth/delete-household-account", (route) => route.abort("failed"));
    await second.getByLabel("Current password", { exact: true }).fill(password);
    await memberSubmit.click();
    await expect(second.getByRole("main").getByRole("alert")).toContainText("Check your connection");
    await second.unroute("**/api/auth/delete-household-account");
    await second.route("**/api/auth/delete-household-account", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Deletion temporarily unavailable. Try again."}' }));
    await second.getByLabel("Current password", { exact: true }).fill(password);
    await memberSubmit.click();
    await expect(second.getByRole("main").getByRole("alert")).toContainText("temporarily unavailable");
    await second.unroute("**/api/auth/delete-household-account");
    const staleMember = await other.cookies();
    await second.getByLabel("Current password", { exact: true }).fill(password);
    await memberSubmit.click();
    await expect(second).toHaveURL(/\/sign-in$/);
    await other.addCookies(staleMember);
    expect((await other.request.get("http://127.0.0.1:3112/api/account/export")).status()).toBe(401);
    await page.reload();
    await expect(page.getByRole("group", { name: "Cook Synthetic import fixture", exact: true })).toHaveCount(0);
    const successor = "ui-successor@example.test";
    const nextGrant = await legacyInvitation(successor, 300);
    await other.clearCookies();
    await signup(second, successor, { invite: nextGrant });
    await acceptInvite(second);
    await expect(second).toHaveURL("http://127.0.0.1:3112/");
    await page.reload();
    const successorControls = page.getByRole("group", { name: "Cook Synthetic import fixture", exact: true });
    await successorControls.getByRole("button", { name: "Make owner", exact: true }).click();
    await successorControls.getByRole("button", { name: "Confirm role change", exact: true }).click();
    await expect(successorControls.getByRole("button", { name: "Make member", exact: true })).toBeVisible();
    const plan = `/plan/${process.env.E2E_PREP_PLAN_ID}`;
    await second.goto(plan);
    const title = await second.getByRole("main").getByRole("heading", { level: 1 }).innerText();
    await second.goto("/groceries");
    const grocery = await second.getByRole("checkbox").first().isChecked();
    await second.goto(`${plan}/prep`);
    const prep = await second.getByRole("checkbox").first().isChecked();
    await page.getByRole("button", { name: "Delete my account", exact: true }).click();
    await page.getByLabel("Current password", { exact: true }).fill(replacement);
    await page.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
    await page.screenshot({ path: "test-results/account-deletion-phone.png", fullPage: true });
    const linkSent = await page.request.post("/api/auth/sign-in/magic-link", {
      headers: { origin: "http://127.0.0.1:3112", "x-forwarded-for": "127.0.0.31" },
      data: { email: owner.toUpperCase(), callbackURL: "/onboarding", newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/sign-in?emailLinkError=1" },
    });
    expect(linkSent.status()).toBe(200);
    const outstandingLink = z.object({ url: z.string().url() }).parse(JSON.parse(await readFile(testMailPath(owner, "sign-in-link"), "utf8"))).url;
    const staleOwner = await page.context().cookies();
    await submit.click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.context().addCookies(staleOwner);
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    await page.goto(outstandingLink);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("invalid, expired or already used");
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await page.goto(plan);
    await expect(page).toHaveURL(/\/sign-in$/);
    await second.goto(plan);
    await expect(second.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(title);
    await second.goto("/groceries");
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: grocery });
    await second.goto(`${plan}/prep`);
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: prep });
    await second.goto("/account");
    await expect(second.getByRole("link", { name: "Profile: Synthetic import fixture", exact: true })).toBeVisible();
    await expect(second.getByRole("group", { name: "Cook Synthetic owner targets", exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test("signup and sign-in show actionable failures and support retry without storing secrets", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.23" });
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Sign in or create an account", exact: true })).toBeVisible();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("ui-outsider@example.test");
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Check your connection");
  await expect(page.getByRole("button", { name: "Email me a code", exact: true })).toBeEnabled();
  await page.unroute("**/api/auth/email-otp/send-verification-otp");
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"message":"We could not send the email code. Please try again."}',
  }));
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("could not send the email code");
  await page.unroute("**/api/auth/email-otp/send-verification-otp");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "I have a password", exact: true }).click();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
});

test("an emailed link signs in only its opening browser, survives reload and rejects replay with an actionable retry", async ({ page, browser }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const id = randomUUID(), householdId = randomUUID();
  const email = "ui-email-link@example.test";
  const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "127.0.0.85" } });
  try {
    await handle.db.insert(s.authUsers).values({ id, email, emailVerified: true, name: "Synthetic link profile" });
    await handle.db.insert(s.households).values({ id: householdId, name: "Synthetic email-link home" });
    await handle.db.insert(s.householdMembers).values({ householdId, userId: id, role: "owner" });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": "127.0.0.84" });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Email me a link instead", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.route("**/api/auth/sign-in/magic-link", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Email me a link", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Check your connection");
    await expect(page.getByRole("button", { name: "Email me a link", exact: true })).toBeEnabled();
    await page.unroute("**/api/auth/sign-in/magic-link");
    await page.getByRole("button", { name: "Email me a link", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Check your email to continue" })).toBeVisible();
    const mail = z.object({ email: z.literal(email), type: z.literal("sign-in-link"), url: z.string().url() })
      .parse(JSON.parse(await readFile(testMailPath(email, "sign-in-link"), "utf8")));
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await expect(page).toHaveURL(/\/sign-in$/);
    const second = await other.newPage();
    await second.goto(mail.url);
    await expect(second).toHaveURL(/\/onboarding$/);
    await expect(second.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    await second.reload();
    await expect(second.getByLabel("Name", { exact: true })).toHaveValue("Synthetic link profile");
    expect(await (await second.request.get("/api/auth/get-session")).json()).toMatchObject({ user: { email, emailVerified: true } });
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await page.goto(mail.url);
    await expect(page).toHaveURL(/\/sign-in\?emailLinkError=1&error=INVALID_TOKEN$/);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("invalid, expired or already used");
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await page.getByRole("button", { name: "Email me a link instead", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Email me a link", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Check your email to continue" })).toBeVisible();
    const retry = z.object({ url: z.string().url() }).parse(JSON.parse(await readFile(testMailPath(email, "sign-in-link"), "utf8")));
    expect(retry.url).not.toBe(mail.url);
    await page.goto(retry.url);
    await expect(page.getByRole("heading", { name: "Your meal profile", exact: true })).toBeVisible();
    expect(await (await second.request.get("/api/auth/get-session")).json()).toMatchObject({ user: { email } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.visualViewport?.width ?? window.innerWidth))).toBe(true);
  } finally {
    await other.close();
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, id));
    await handle.db.delete(s.authUsers).where(eq(s.authUsers.id, id));
    await handle.db.delete(s.households).where(eq(s.households.id, householdId));
    await handle.close();
  }
});
