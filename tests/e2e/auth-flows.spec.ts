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

test("real auth routes verify signup, restore sessions, sign in by code and revoke both browsers on reset", async ({ page, browser }) => {
  await page.goto("/");
  const signedUp = await call(page, "/sign-up/email", { name: "Synthetic browser cook", email, password }, {
    "x-household-bootstrap": "synthetic-browser-bootstrap-key-for-tests",
  });
  expect(signedUp.status).toBe(200);
  expect((await call(page, "/email-otp/verify-email", { email, otp: await code("email-verification") })).status).toBe(200);
  expect((await call(page, "/sign-in/email", { email, password })).status).toBe(200);
  await page.reload();
  const session = await call(page, "/get-session");
  expect(session.cache).toBe("private, no-store");
  expect(session.body).toMatchObject({ user: { email, emailVerified: true } });
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto("http://127.0.0.1:3112/");
    expect((await call(second, "/sign-in/email", { email, password })).status).toBe(200);
    expect((await call(page, "/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    expect((await call(page, "/sign-in/email-otp", { email, otp: await code("sign-in") })).status).toBe(200);
    expect((await call(page, "/email-otp/request-password-reset", { email })).status).toBe(200);
    const replacement = "Synthetic-browser-replacement-456!";
    expect((await call(page, "/email-otp/reset-password", { email, otp: await code("forget-password"), password: replacement })).status).toBe(200);
    expect((await call(page, "/get-session")).body).toBeNull();
    expect((await call(second, "/get-session")).body).toBeNull();
    expect((await call(page, "/sign-in/email", { email, password })).status).toBe(401);
    expect((await call(page, "/sign-in/email", { email, password: replacement })).status).toBe(200);
    expect((await call(page, "/sign-out", {})).status).toBe(200);
    expect((await call(page, "/get-session")).body).toBeNull();
  } finally { await other.close(); }
});

test("an uninvited signup never creates a usable session", async ({ page }) => {
  await page.goto("/");
  expect((await call(page, "/sign-up/email", { name: "Synthetic outsider", email: "browser-outsider@example.test", password })).status).toBe(403);
  expect((await call(page, "/get-session")).body).toBeNull();
});
