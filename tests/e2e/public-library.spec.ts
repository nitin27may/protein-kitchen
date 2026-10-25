import { expect, test, type Page } from "@playwright/test";

const SHELL_PAGES = ["/", "/recipes", "/ingredients", "/recipes/tofu-burrito-bowl", "/ingredients/tofu-extra-firm", "/groceries", "/profiles", "/plan"];

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Visible links and buttons in the shell and the page header area that are shorter than a 44 px tap target. */
async function smallTargets(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els.flatMap((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || style.visibility === "hidden" || style.display === "none") return [];
      return box.height < 43.5 ? [`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.height)}px`] : [];
    }));
}

test("a visitor gets the member shell on desktop, with an account slot and the same library pages", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Plan", "Recipes", "Ingredients", "Groceries", "Profiles"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  const slot = page.getByRole("group", { name: "Account" });
  await expect(slot.getByRole("link", { name: "Create account", exact: true })).toBeVisible();
  await expect(slot.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review photos" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Make a plan", exact: true }).first()).toHaveAttribute("href", "/plan/new");

  await nav.getByRole("link", { name: "Recipes", exact: true }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.getByRole("button", { name: /Filters/ })).toBeVisible();
  await expect(page.getByRole("combobox").first()).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search recipes" });
  await search.fill("tofu burrito");
  await expect(page).toHaveURL(/q=tofu/);
  await expect(page.locator('main a[href="/recipes/tofu-burrito-bowl"]')).toBeVisible();
  await expect(page.locator('main a[href^="/recipes/"]').first()).toHaveAttribute("href", "/recipes/tofu-burrito-bowl");

  // A search by ingredient finds recipes whose name does not contain it.
  await search.fill("paneer");
  await expect(page.locator('main a[href^="/recipes/"]').first()).toBeVisible();
  expect(await page.locator('main a[href^="/recipes/"]').count()).toBeGreaterThan(1);

  // Filters work without an account but nothing offers to save a view.
  await page.getByRole("button", { name: /Filters/ }).click();
  await expect(page.getByRole("dialog").getByText("Save as my default")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Yours" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await search.fill("tofu burrito");
  await page.locator('main a[href="/recipes/tofu-burrito-bowl"]').click();
  await expect(page).toHaveURL(/\/recipes\/tofu-burrito-bowl$/);
  await expect(page.getByRole("heading", { name: "Per serving", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Method|Putting it together/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Favourite|Cooked and tested|Never suggest/ })).toHaveCount(0);
  await expect(page.getByText(/Add a photo|Add a link|Watch and read/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create an account to cook and save" })).toBeVisible();
  const content = await page.content();
  expect(content).not.toContain("Synthetic");
  expect(content).not.toContain("/photos/");
  const rsc = await page.request.get("/recipes/tofu-burrito-bowl?plan=1", { headers: { RSC: "1" } });
  expect(rsc.status()).toBe(200);
  expect(await rsc.text()).not.toContain("Synthetic");

  await nav.getByRole("link", { name: "Ingredients", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search ingredients" }).fill("tofu");
  await page.locator('main a[href="/ingredients/tofu-extra-firm"]').click();
  await expect(page.getByRole("heading", { name: /Per 100 g/ })).toBeVisible();
  await expect(page.getByText(/Source:/)).toBeVisible();
  await expect(page.getByText(/adult man|adult woman/)).toHaveCount(0);
});

test("household pages show a clear anonymous state instead of redirecting", async ({ page }) => {
  for (const [url, heading, action] of [["/groceries", "Groceries", "Create a plan"], ["/profiles", "Profiles", "Create a plan"], ["/plan", "Plan", "Create a plan"]] as const) {
    await page.goto(url);
    await expect(page).toHaveURL(new RegExp(`${url}$`));
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: action, exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  }
});

test("anonymous HTML for shell pages carries no household or profile fixture data", async ({ browser }) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    for (const url of SHELL_PAGES) {
      for (const headers of [{}, { RSC: "1" }] as Record<string, string>[]) {
        const response = await anonymous.request.get(url, { headers });
        expect(response.status(), url).toBe(200);
        const body = await response.text();
        expect(body, url).not.toMatch(/Synthetic|Fixture|authorized-browser-fixture|\/photos\/|uploads\//);
        expect(body, url).not.toMatch(/"personId"|householdId|reminderTime/);
      }
    }
  } finally { await anonymous.close(); }
});

test("the shell fits a 390 px phone: no overflow, 44 px tap targets, account slot in the header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of SHELL_PAGES) {
    await page.goto(url);
    await expect(page.getByRole("link", { name: "Sign in / Create account" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Recipes", exact: true })).toBeVisible();
    await noHorizontalScroll(page);
    expect(await smallTargets(page, "header a, header button, nav[aria-label=Main] a, main a[class*=min-h], main button"), url).toEqual([]);
  }
  await page.goto("/recipes");
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("zzzz");
  await expect(page.getByText("No recipes match.")).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("");
  await page.getByRole("button", { name: /Filters/ }).click();
  expect(await smallTargets(page, "dialog button, dialog label"), "filter sheet").toEqual([]);
  await page.keyboard.press("Escape");
  await page.goto("/recipes/tofu-burrito-bowl");
  await page.screenshot({ path: "test-results/library-recipe-phone.png", fullPage: true });
  await page.getByRole("link", { name: "Sign in / Create account" }).click();
  await expect(page.getByRole("heading", { name: /Sign in/ })).toBeVisible();
});

test("unknown subjects and routines return 404", async ({ page }) => {
  for (const url of ["/recipes/nonexistent-library-item", "/ingredients/nonexistent-library-item", "/recipes/methi-water"]) {
    const response = await page.goto(url);
    expect(response!.status()).toBe(404);
  }
});
