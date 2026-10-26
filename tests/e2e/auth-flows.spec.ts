import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { testMailPath } from "../../lib/auth/test-mail";

const email = "browser-owner@example.test";
const password = "Synthetic-browser-password-123!";
async function call(page: Page, path: string, body?: object, headers: Record<string, string> = {}) {
  return page.evaluate(async ({ path, body, headers }) => {
    const response = await fetch(`/api/auth${path}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  }, { path, body, headers });
}
async function code(type: "email-verification" | "sign-in" | "forget-password") {
  return z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(
    await readFile(testMailPath(email, type), "utf8"),
  )).otp;
}

test("real auth routes create a verified account from a code, restore sessions, sign in by password and revoke both browsers on reset", async ({ page, browser }) => {
  await page.goto("/");
  const address = { "x-forwarded-for": "127.0.0.51" };
  expect((await call(page, "/sign-up/email", { name: "Synthetic browser cook", email, password }, address)).status).toBe(400);
  expect((await call(page, "/get-session")).body).toBeNull();
  expect((await call(page, "/sign-in/email-otp", { email, otp: "000000" }, address)).status).not.toBe(200);
  expect((await call(page, "/get-session")).body).toBeNull();
  const requested = await call(page, "/email-otp/send-verification-otp", { email, type: "sign-in" }, address);
  expect(requested.status).toBe(200);
  expect((await call(page, "/sign-in/email-otp", { email, otp: await code("sign-in") }, address)).status).toBe(200);
  await page.reload();
  const session = await call(page, "/get-session");
  expect(session.cache).toBe("private, no-store");
  expect(session.body).toMatchObject({ user: { email, emailVerified: true } });
  // A password is optional and set later, through the emailed reset code.
  expect((await call(page, "/email-otp/request-password-reset", { email }, address)).status).toBe(200);
  expect((await call(page, "/email-otp/reset-password", { email, otp: await code("forget-password"), password }, address)).status).toBe(200);
  expect((await call(page, "/get-session")).body).toBeNull();
  expect((await call(page, "/sign-in/email", { email, password }, address)).status).toBe(200);
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto("http://127.0.0.1:3112/");
    expect((await call(second, "/sign-in/email", { email, password }, { "x-forwarded-for": "127.0.0.52" })).status).toBe(200);
    expect((await call(page, "/email-otp/request-password-reset", { email }, address)).status).toBe(200);
    const replacement = "Synthetic-browser-replacement-456!";
    expect((await call(page, "/email-otp/reset-password", { email, otp: await code("forget-password"), password: replacement }, address)).status).toBe(200);
    expect((await call(page, "/get-session")).body).toBeNull();
    expect((await call(second, "/get-session")).body).toBeNull();
    expect((await call(page, "/sign-in/email", { email, password }, address)).status).toBe(401);
    expect((await call(page, "/sign-in/email", { email, password: replacement }, address)).status).toBe(200);
    expect((await call(page, "/sign-out", {})).status).toBe(200);
    expect((await call(page, "/get-session")).body).toBeNull();
  } finally { await other.close(); }
});

test("a request for a code answers identically for a known and a new address and creates nothing", async ({ page }) => {
  await page.goto("/");
  const address = { "x-forwarded-for": "127.0.0.53" };
  // A second account, so the main test's address has not already used its per-recipient mail allowance.
  const knownEmail = "browser-known@example.test";
  expect((await call(page, "/email-otp/send-verification-otp", { email: knownEmail, type: "sign-in" }, address)).status).toBe(200);
  const otp = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(JSON.parse(await readFile(testMailPath(knownEmail, "sign-in"), "utf8"))).otp;
  expect((await call(page, "/sign-in/email-otp", { email: knownEmail, otp }, address)).status).toBe(200);
  expect((await call(page, "/sign-out", {})).status).toBe(200);
  const known = await call(page, "/email-otp/send-verification-otp", { email: knownEmail, type: "sign-in" }, address);
  const fresh = await call(page, "/email-otp/send-verification-otp", { email: "browser-newcomer@example.test", type: "sign-in" }, address);
  expect(fresh).toEqual(known);
  expect((await call(page, "/get-session")).body).toBeNull();
});
