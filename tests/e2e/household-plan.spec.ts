import { test, expect } from "./member-fixture";
import type { Page } from "@playwright/test";
import sharp from "sharp";

async function mutation(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).origin === "http://127.0.0.1:3112");
  await action();
  expect((await response).status()).toBe(200);
}

test("plan generation, swap and locked regeneration survive reload", async ({ page }) => {
  await page.goto("/plan/new");
  await expect(page.getByRole("button", { name: "Generate plan", exact: true })).toBeVisible();
  await mutation(page, () => page.getByRole("button", { name: "Generate plan", exact: true }).click());
  await expect(page).toHaveURL(/\/plan\/\d+(\?.*)?$/);
  await page.getByRole("button", { name: "Swap", exact: true }).first().click();
  const pick = page.getByRole("button", { name: "Pick this", exact: true }).first();
  await expect(pick).toBeVisible();
  const candidate = await pick.locator("..").locator("p").first().innerText();
  await mutation(page, () => pick.click());
  await page.reload();
  await expect(page.getByRole("main")).toContainText(candidate);
  await mutation(page, () => page.getByRole("button", { name: "Lock", exact: true }).first().click());
  await mutation(page, () => page.getByRole("button", { name: "Regenerate", exact: true }).click());
  await page.reload();
  await expect(page.getByRole("main")).toContainText(candidate);
  await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
});

test("shopping progress is shared between independent browser contexts and persists", async ({ page, browser }) => {
  await page.goto("/groceries");
  const first = page.getByRole("checkbox").first();
  await expect(first).toBeVisible();
  const value = await first.isChecked();
  await mutation(page, () => first.setChecked(!value));
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await other.addCookies(await page.context().cookies());
    const second = await other.newPage();
    await second.goto("http://127.0.0.1:3112/groceries");
    await expect(second.getByRole("checkbox").first()).toBeChecked({ checked: !value });
    await page.reload();
    await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !value });
  } finally { await other.close(); }
});

test("night-before prep completion survives reload", async ({ page }) => {
  await page.goto(`/plan/${process.env.E2E_PREP_PLAN_ID}/prep`);
  const checkbox = page.getByRole("checkbox").first();
  await expect(checkbox).toBeVisible();
  const checked = await checkbox.isChecked();
  await mutation(page, () => checkbox.setChecked(!checked));
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
});

test("Excel and PDF exports return actual file payloads", async ({ request }) => {
  const id = process.env.E2E_PREP_PLAN_ID;
  const excel = await request.get(`/api/plan/${id}/export?format=xlsx`);
  expect(excel.status()).toBe(200);
  expect(excel.headers()["content-type"]).toContain("spreadsheetml");
  expect((await excel.body()).subarray(0, 2).toString()).toBe("PK");
  const pdf = await request.get(`/api/plan/${id}/export?format=pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
});

test("photo rejection persists, and a failed request displays an error then allows retry", async ({ page }) => {
  await page.goto("/photos/review");
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  const count = await reject.count();
  expect(count).toBeGreaterThan(0);
  await mutation(page, () => reject.first().click());
  await expect(reject).toHaveCount(count - 1);
  await page.reload();
  await expect(reject).toHaveCount(count - 1);
  await page.route("**/photos/review", async (route) => {
    if (route.request().method() === "POST") await route.abort("failed");
    else await route.continue();
  });
  await reject.first().click();
  await expect(page.getByRole("alert").filter({ hasText: "The photo decision could not" })).toBeVisible();
  await expect(reject).toHaveCount(count - 1);
  await page.unroute("**/photos/review");
  await mutation(page, () => reject.first().click());
  await expect(reject).toHaveCount(count - 2);
  await page.reload();
  await expect(reject).toHaveCount(count - 2);
});

test("private photo upload, reload and deletion preserve actual WebP bytes and recover from request failures", async ({ page, browser }) => {
  const recipe = "/recipes/tofu-burrito-bowl";
  await page.goto(recipe);
  const photos = page.locator('section[aria-labelledby="photos"]');
  const file = {
    name: "synthetic-meal.jpg", mimeType: "image/jpeg",
    buffer: await sharp({ create: { width: 900, height: 600, channels: 3, background: "#c87828" } }).jpeg().toBuffer(),
  };
  await page.route("**/recipes/tofu-burrito-bowl", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await photos.locator('input[type="file"]').setInputFiles(file);
  await expect(photos.getByRole("alert")).toContainText("could not be uploaded");
  await expect(photos.getByRole("button", { name: "Add a photo", exact: true })).toBeEnabled();
  await page.unroute("**/recipes/tofu-burrito-bowl");
  await photos.locator('input[type="file"]').setInputFiles(file);
  await expect(photos.getByText("Your photo", { exact: false })).toBeVisible();
  await expect(photos.getByRole("button", { name: "Add another", exact: true })).toBeEnabled();
  await page.reload();
  const image = photos.locator("img").first();
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  expect(url).toMatch(/^\/photos\/[0-9a-f-]+\/thumb$/);
  const response = await page.request.get(url!);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const metadata = await sharp(await response.body()).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.exif).toBeUndefined();
  expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(640);
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    expect((await anonymous.request.get(`http://127.0.0.1:3112${url}`)).status()).toBe(401);
  } finally { await anonymous.close(); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/private-photo-phone.png", fullPage: true });
  await photos.getByRole("button", { name: "Delete", exact: true }).click();
  await page.route("**/recipes/tofu-burrito-bowl", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await photos.getByRole("button", { name: "Delete photo", exact: true }).click();
  await expect(photos.getByRole("alert")).toContainText("photo change could not be saved");
  await expect(image).toBeVisible();
  await page.unroute("**/recipes/tofu-burrito-bowl");
  await photos.getByRole("button", { name: "Delete", exact: true }).click();
  await photos.getByRole("button", { name: "Delete photo", exact: true }).click();
  await expect(photos.getByText("No photo yet.", { exact: false })).toBeVisible();
  await page.reload();
  expect((await page.request.get(url!)).status()).toBe(404);
});
