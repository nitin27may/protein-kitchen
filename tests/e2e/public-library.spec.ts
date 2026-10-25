import { expect, test } from "@playwright/test";

test("anonymous visitors browse and search library details without private controls or household data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Public navigation" });
  await expect(nav.getByRole("link", { name: "Recipes", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Ingredients", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Create account", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Profiles", exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search recipes" }).fill("tofu burrito");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: /Tofu burrito bowl/ }).click();
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/);
  await expect(page.getByRole("heading", { name: "Nutrition per serving", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Method", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Favourite", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Upload|tested|Ban/i })).toHaveCount(0);
  expect(await page.content()).not.toContain("Synthetic import fixture");
  expect(await page.content()).not.toContain("/photos/");
  const rsc = await page.request.get("/recipes/tofu-burrito-bowl?plan=1", { headers: { RSC: "1" } });
  expect(rsc.status()).toBe(200);
  expect(await rsc.text()).not.toContain("Synthetic import fixture");
  await nav.getByRole("link", { name: "Ingredients", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search ingredients" }).fill("tofu");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.locator('main a[href="/ingredients/tofu-extra-firm"]').click();
  await expect(page.getByRole("heading", { name: "Nutrition source", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Nutrition per 100 g/ })).toBeVisible();
  await page.screenshot({ path: "test-results/public-ingredient-phone.png", fullPage: true });
});

test("public navigation fits phone and desktop; unknown subjects return 404", async ({ page }) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/recipes?q=NoSuchRecipeFixture");
    await expect(page.getByText("No matches. Try another name.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("navigation", { name: "Public navigation" }).getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in or create an account", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  }
  for (const url of ["/recipes/nonexistent-library-item", "/ingredients/nonexistent-library-item", "/recipes/methi-water"]) {
    const response = await page.goto(url);
    expect(response!.status()).toBe(404);
  }
});
