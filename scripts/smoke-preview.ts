import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const input = process.env.PREVIEW_SMOKE_URL;
const bypass = process.env.PREVIEW_PROTECTION_BYPASS;
if (!input || !bypass) throw new Error("Set PREVIEW_SMOKE_URL and a server-only PREVIEW_PROTECTION_BYPASS.");
const origin = new URL(input);
if (origin.protocol !== "https:" || !origin.hostname.endsWith(".vercel.app") ||
    origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("Hosted smoke requires an explicit HTTPS Vercel preview origin.");
}
const anonymous = await fetch(new URL("/recipes", origin), { redirect: "manual" });
assert.ok([302, 303, 307, 308, 401, 403].includes(anonymous.status), "Deployment protection must deny anonymous access.");

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin.origin) {
      await route.continue({
        headers: { ...route.request().headers(), "x-vercel-protection-bypass": bypass },
      });
    } else {
      await route.continue();
    }
  });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  for (const path of ["/recipes", "/ingredients", "/techniques", "/sign-in"]) {
    const response = await page.goto(new URL(path, origin).toString());
    assert.equal(response?.status(), 200, `Hosted ${path} must render successfully.`);
    await page.locator("h1").first().waitFor();
    assert.ok((await page.locator("body").innerText()).trim().length > 100, `${path} must have real content.`);
  }
  await page.goto(new URL("/account", origin).toString());
  await page.waitForURL((url) => url.pathname === "/sign-in");
  assert.equal(errors.length, 0, "Hosted browser must have no uncaught application errors.");
  await page.goto(new URL("/recipes", origin).toString());
  if (process.env.PREVIEW_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PREVIEW_SMOKE_SCREENSHOT, fullPage: false });
  console.log("Protected preview browser passed: anonymous denial, four rendered routes, private-account redirect and no uncaught errors.");
} finally {
  await browser.close();
}
