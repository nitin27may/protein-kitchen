import { test, expect } from "./member-fixture";
import type { Page } from "@playwright/test";

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
