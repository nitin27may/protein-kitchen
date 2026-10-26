import { test, expect } from "./member-fixture";

/**
 * Launch gate: library photo candidate review is off in production. The browser server runs with the flag unset (on) by
 * default, so this case needs the server started with it forced off:
 *   PHOTO_REVIEW_ENABLED=false pnpm test:e2e tests/e2e/photo-gate.spec.ts
 */
test.skip(process.env.PHOTO_REVIEW_ENABLED !== "false", "Run with PHOTO_REVIEW_ENABLED=false");

test("with photo review off the page is 404 and no link to it is shown, while photo credits still work", async ({ page }) => {
  const response = await page.goto("/photos/review");
  expect(response?.status()).toBe(404);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Photos", exact: true })).toBeVisible();
  await expect(page.locator('a[href="/photos/review"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Photo credits", exact: true })).toBeVisible();

  const credits = await page.goto("/credits");
  expect(credits?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Photo credits", exact: true })).toBeVisible();
  await expect(page.locator('a[href="/photos/review"]')).toHaveCount(0);
});
