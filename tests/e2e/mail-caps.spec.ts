import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { access, rm } from "node:fs/promises";
import { testMailPath } from "../../lib/auth/test-mail";

/**
 * Runs in two modes against the same dev server, which inherits SIGNUP_ALLOWLIST from the environment:
 *   default (unset)                      -> open signup; the allowlist tests skip.
 *   SIGNUP_ALLOWLIST=listed@example.test -> invite-only; run only this spec in that mode, the rest of the suite assumes open signup.
 */
const inviteOnly = Boolean(process.env.SIGNUP_ALLOWLIST?.trim());
const listed = "listed@example.test";
const unlisted = "unlisted@example.test";

async function requestCode(page: Page, email: string, ip: string) {
  return page.evaluate(async ({ email, ip }) => {
    const response = await fetch("/api/auth/email-otp/send-verification-otp", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    return { status: response.status, cache: response.headers.get("cache-control"), text: await response.text() };
  }, { email, ip });
}
const delivered = (email: string) => access(testMailPath(email, "sign-in")).then(() => true, () => false);

test("a fourth code request for one address inside 15 minutes is refused with the generic failure and nothing is delivered", async ({ page }) => {
  test.skip(inviteOnly, "uses an address that the allowlist would block");
  const email = "cap-user@example.test";
  await rm(testMailPath(email, "sign-in"), { force: true });
  await page.goto("/");
  for (let i = 0; i < 3; i++) expect((await requestCode(page, email, "127.0.0.61")).status).toBe(200);
  await rm(testMailPath(email, "sign-in"), { force: true });
  const capped = await requestCode(page, email, "127.0.0.62");
  expect(capped.status).toBe(503);
  expect(JSON.parse(capped.text)).toEqual({ message: "We could not send the email code. Please try again." });
  expect(await delivered(email)).toBe(false);
});

test("open signup shows no invite-only line", async ({ page }) => {
  test.skip(inviteOnly, "allowlist is set in this run");
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await expect(page.getByText("Sign-up is invite-only for now.")).toHaveCount(0);
});

test("invite-only: unlisted addresses get the same answer as listed ones but no mail, and the page says so", async ({ page }) => {
  test.skip(!inviteOnly, "run with SIGNUP_ALLOWLIST=listed@example.test");
  await rm(testMailPath(listed, "sign-in"), { force: true });
  await rm(testMailPath(unlisted, "sign-in"), { force: true });
  await page.goto("/sign-in");
  await expect(page.getByText("Sign-up is invite-only for now.")).toBeVisible();
  const yes = await requestCode(page, listed, "127.0.0.63");
  const no = await requestCode(page, unlisted, "127.0.0.63");
  expect(no).toEqual(yes);
  expect(yes.status).toBe(200);
  expect(await delivered(listed)).toBe(true);
  expect(await delivered(unlisted)).toBe(false);
});
