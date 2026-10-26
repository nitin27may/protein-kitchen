import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { openPostgres } from "../../lib/db/postgres/client";
import { authAccounts, authSessions, authUsers, householdMembers, libraryPhotoDecisions, libraryPhotos, people } from "../../lib/db/schema";
import { loadCandidates, type Candidate } from "../../lib/photos/candidates";
import { noHorizontalScroll, smallTargets } from "./layout";
import { expect, test } from "./member-fixture";
import { e2eTarget } from "./target";

/**
 * Library photo review: multi-select, bulk approve and reject, per-item results, retry, the Decided view, phone layout and
 * keyboard use. Provider thumbnails are answered from a local JPEG (nothing leaves this machine), and approvals read the
 * per-run fixture copy that scripts/e2e-server.ts builds (licence entries for every candidate, images/default.jpg).
 */
test.describe.configure({ mode: "serial" });

const candidates = loadCandidates(process.cwd());
const licenceFile = path.resolve(".next-e2e-fixture/photos/licences.json");
const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}`;
const thumbnail = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKgAD//Z", "base64");

/** Subjects this run touches: from the end of the alphabet, so earlier specs that act on the first listed subjects do not collide. */
function pick(kind: "ingredients" | "recipes", count: number): { slug: string; list: Candidate[] }[] {
  const all = candidates[kind];
  return Object.keys(all)
    .filter((slug) => all[slug]!.length >= 2 && slug.length >= 6 && !Object.keys(all).some((other) => other !== slug && other.includes(slug)) && !all[slug]!.some((c) => /synthetic|fixture/i.test(`${c.title} ${c.author}`)))
    .sort().reverse().slice(0, count).map((slug) => ({ slug, list: all[slug]! }));
}
const [ingredientA, ingredientB, ingredientD] = pick("ingredients", 3);
const [recipeC] = pick("recipes", 1);

const refOf = (kind: "recipe" | "ingredient", slug: string, key: string) => `${kind}:${slug}:${key}`;
const tileInputs = (page: Page, kind: "recipe" | "ingredient", slug: string) => page.locator(`input[data-ref^="${kind}:${slug}:"]`);
const labelOf = (page: Page, ref: string) => page.locator("label", { has: page.locator(`input[data-ref="${ref}"]`) });
const bar = (page: Page) => page.getByRole("region", { name: "Selection actions" });
const status = (page: Page) => bar(page).getByRole("status");

async function blockRemoteImages(page: Page) {
  const hosts = new Set<string>();
  await page.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), async (route) => {
    hosts.add(new URL(route.request().url()).hostname);
    if (route.request().resourceType() === "image") await route.fulfill({ status: 200, contentType: "image/jpeg", body: thumbnail });
    else await route.abort();
  });
  return hosts;
}

async function search(page: Page, text: string) {
  await page.getByRole("searchbox", { name: "Search photos to review" }).fill(text);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(text)}`));
}

async function setLicenceEntry(key: string, present: boolean, original?: string) {
  const entries = JSON.parse(await readFile(licenceFile, "utf8")) as Record<string, string>;
  if (present) entries[key] = original!;
  else delete entries[key];
  await writeFile(licenceFile, JSON.stringify(entries));
}

async function libraryRows(slug: string) {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const rows = await handle.db.select({ key: libraryPhotos.candidateKey, cover: libraryPhotos.isCover, uid: libraryPhotos.uid }).from(libraryPhotos).where(eq(libraryPhotos.ingredientSlug, slug));
    return rows;
  } finally { await handle.close(); }
}
async function decisionRows(slug: string) {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    return await handle.db.select({ key: libraryPhotoDecisions.candidateKey, decision: libraryPhotoDecisions.decision }).from(libraryPhotoDecisions).where(eq(libraryPhotoDecisions.subjectSlug, slug));
  } finally { await handle.close(); }
}

test("the fixture subjects exist in the candidate list", () => {
  expect(ingredientA && ingredientB && ingredientD && recipeC, "need three ingredients and one recipe with two or more candidates").toBeTruthy();
});

test("shift-click selects a range, the bulk buttons add to it, and the count is shown by kind", async ({ page }) => {
  await blockRemoteImages(page);
  await page.goto("/photos/review?kind=ingredient&missing=1");
  const boxes = page.locator("input[data-ref]");
  await expect(boxes.first()).toBeVisible();
  const total = await boxes.count();
  expect(total).toBeGreaterThan(8);

  // Every tile's whole label is at least 44 px tall, and the checkboxes are native.
  const heights = await page.locator("label:has(input[data-ref])").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  await expect(boxes.first()).toHaveAttribute("type", "checkbox");

  const refs = await boxes.evaluateAll((els) => els.map((el) => el.getAttribute("data-ref")!));
  await labelOf(page, refs[1]!).click();
  await expect(status(page)).toHaveText("1 selected (1 ingredient)");
  await labelOf(page, refs[5]!).click({ modifiers: ["Shift"] });
  await expect(status(page)).toHaveText("5 selected (5 ingredients)");
  for (const [n, ref] of refs.entries()) await expect(page.locator(`input[data-ref="${ref}"]`)).toBeChecked({ checked: n >= 1 && n <= 5 });
  // Shift-click back over the same range keeps the anchor's state; a plain click on a selected tile turns it off.
  await labelOf(page, refs[3]!).click();
  await expect(status(page)).toHaveText("4 selected (4 ingredients)");

  await page.getByRole("button", { name: "Select all shown", exact: true }).click();
  await expect(status(page)).toHaveText(`${total} selected (${total} ingredients)`);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(bar(page)).toHaveCount(0);

  const subjects = await page.getByRole("heading", { level: 2 }).count();
  await page.getByRole("button", { name: "Select first photo of each subject", exact: true }).click();
  await expect(status(page)).toHaveText(`${subjects} selected (${subjects} ingredients)`);
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  // "Select all N matching" asks the server, so it reaches past the 30 subjects shown.
  const matching = page.getByRole("button", { name: /^Select all \d+ matching$/ });
  const matchingCount = Number((await matching.innerText()).replace(/\D/g, ""));
  expect(matchingCount).toBeGreaterThanOrEqual(total);
  await matching.click();
  await expect(status(page)).toHaveText(new RegExp(`^${matchingCount} selected \\(${matchingCount} ingredients\\)$`));

  // Selection survives paging within the session.
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("Page 2 of")).toBeVisible();
  await expect(status(page)).toHaveText(new RegExp(`^${matchingCount} selected`));
  await expect(page.locator("input[data-ref]:checked").first()).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
});

test("a cancelled run stops after the current group, a dropped request fails only its own group, and nothing is saved", async ({ page }) => {
  await blockRemoteImages(page);
  await page.goto("/photos/review?kind=ingredient&missing=1");
  await page.getByRole("button", { name: "Select all shown", exact: true }).click();
  const total = await page.locator("input[data-ref]:checked").count();
  expect(total).toBeGreaterThan(12);
  const before = (await libraryRows(ingredientA!.slug)).length;
  let posts = 0;
  await page.route(/\/photos\/review/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.abort("failed");
  });
  await page.getByRole("button", { name: "Approve selected", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Approve ${total} photos?` })).toBeVisible();
  await dialog.getByRole("button", { name: `Approve ${total} photos`, exact: true }).click();
  await expect(status(page)).toHaveText(`Approving 0 of ${total}`);
  await bar(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(status(page)).toHaveText(`Approved 0 of ${total}. 6 failed. ${total - 6} not tried`);
  expect(posts).toBe(1);
  const results = page.locator("#review-results");
  await expect(results.locator('li[data-status="failed"]')).toHaveCount(6);
  await expect(results.locator('li[data-status="failed"]').first()).toContainText("The request did not finish");
  await expect(results.locator('li[data-status="not-attempted"]')).toHaveCount(total - 6);
  await expect(results.getByRole("button", { name: `Retry failed (${total})` })).toBeVisible();
  // Everything stays selected, and nothing reached the database.
  await expect(page.locator("input[data-ref]:checked")).toHaveCount(total);
  expect((await libraryRows(ingredientA!.slug)).length).toBe(before);
  await page.unroute(/\/photos\/review/);
  await results.getByRole("button", { name: "Dismiss results" }).click();
  await bar(page).getByRole("button", { name: "Clear selection" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("approve across searches: confirm dialog, progress, per-item results, a failed item stays selected, Retry failed succeeds", async ({ page }) => {
  test.setTimeout(120_000);
  await blockRemoteImages(page);
  const [a1, a2] = ingredientA!.list;
  const b1 = ingredientB!.list[0]!;
  const c1 = recipeC!.list[0]!;
  const original = b1.provider === "commons" ? b1.licence : "by";
  await page.goto("/photos/review");
  // Pick across three searches; the selection is kept while the list changes.
  await search(page, ingredientA!.slug);
  await labelOf(page, refOf("ingredient", ingredientA!.slug, a1!.key)).click();
  await labelOf(page, refOf("ingredient", ingredientA!.slug, a2!.key)).click();
  await search(page, ingredientB!.slug);
  await tileInputs(page, "ingredient", ingredientB!.slug).first().waitFor();
  await labelOf(page, refOf("ingredient", ingredientB!.slug, b1.key)).click();
  await search(page, recipeC!.slug);
  await tileInputs(page, "recipe", recipeC!.slug).first().waitFor();
  await labelOf(page, refOf("recipe", recipeC!.slug, c1.key)).click();
  await expect(status(page)).toHaveText("4 selected (1 recipe, 3 ingredients)");

  // One photo is made to fail: the provider no longer lists its licence.
  await setLicenceEntry(b1.key, false);
  const approve = bar(page).getByRole("button", { name: "Approve selected", exact: true });
  await approve.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Approve 4 photos?" })).toBeVisible();
  await expect(dialog).toContainText("They will show to everyone, including visitors without an account.");
  await expect(dialog).toContainText("4 selected (1 recipe, 3 ingredients) across 3 subjects.");
  // Escape cancels, nothing is sent, the selection stays, and focus goes back to the bar button.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();
  await expect(status(page)).toHaveText("4 selected (1 recipe, 3 ingredients)");

  await approve.click();
  await dialog.getByRole("button", { name: "Approve 4 photos", exact: true }).click();
  await expect(status(page)).toHaveText("Approved 3 of 4. 1 failed", { timeout: 60_000 });
  const results = page.locator("#review-results");
  await expect(results.locator('li[data-status="approved"]')).toHaveCount(3);
  const failed = results.locator('li[data-status="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(b1.title);
  await expect(failed).toContainText(/licence|check/i);
  // Failed items stay selected; settled ones are cleared from the selection.
  await expect(page.getByRole("region", { name: "Selection actions" }).getByRole("status")).toBeVisible();
  expect((await libraryRows(ingredientA!.slug)).map((r) => r.key).sort()).toEqual([a1!.key, a2!.key].sort());
  expect(await libraryRows(ingredientB!.slug)).toHaveLength(0);

  await setLicenceEntry(b1.key, true, original);
  await results.getByRole("button", { name: "Retry failed (1)" }).click();
  await expect(status(page)).toHaveText("Approved 1 of 1", { timeout: 60_000 });
  await expect(results.locator('li[data-status="approved"]')).toHaveCount(4);
  await expect(results.locator('li[data-status="failed"]')).toHaveCount(0);
  expect((await libraryRows(ingredientB!.slug)).map((r) => r.key)).toEqual([b1.key]);
  await expect(results.getByRole("button", { name: /Retry failed/ })).toHaveCount(0);
});

test("the Decided view shows approved photos and rejected candidates with Make cover, Remove and Undo reject", async ({ page }) => {
  test.setTimeout(120_000);
  await blockRemoteImages(page);
  const [a1, a2] = ingredientA!.list;
  const list = ingredientD!.list;

  // Reject every candidate of one ingredient in bulk.
  await page.goto("/photos/review");
  await search(page, ingredientD!.slug);
  await tileInputs(page, "ingredient", ingredientD!.slug).first().waitFor();
  await page.getByRole("button", { name: "Select all shown", exact: true }).click();
  await bar(page).getByRole("button", { name: "Reject selected", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Reject ${list.length} photos?` })).toBeVisible();
  await dialog.getByRole("button", { name: `Reject ${list.length} photos`, exact: true }).click();
  await expect(status(page)).toHaveText(`Rejected ${list.length} of ${list.length}`, { timeout: 60_000 });
  await expect(page.locator('#review-results li[data-status="rejected"]')).toHaveCount(list.length);
  await expect(tileInputs(page, "ingredient", ingredientD!.slug)).toHaveCount(0);
  expect((await decisionRows(ingredientD!.slug)).filter((d) => d.decision === "rejected")).toHaveLength(list.length);

  // Decided view: the rejections are listed, and undoing one puts it back in the pending list.
  await page.getByRole("button", { name: "Decided", exact: true }).click();
  await expect(page).toHaveURL(/status=decided/);
  const rejected = page.locator('li[data-state="rejected"]');
  await expect(rejected).toHaveCount(list.length);
  await expect(rejected.first().getByRole("link", { name: "Open the source page" })).toBeVisible();
  const undone = list[0]!;
  await rejected.filter({ hasText: undone.title }).first().getByRole("button", { name: "Undo reject", exact: true }).click();
  await expect(rejected).toHaveCount(list.length - 1);
  expect((await decisionRows(ingredientD!.slug)).find((d) => d.key === undone.key)).toBeUndefined();
  await page.goto(`/photos/review?q=${ingredientD!.slug}`);
  await expect(tileInputs(page, "ingredient", ingredientD!.slug)).toHaveCount(1);

  // Make cover and Remove on the two approved photos of ingredient A.
  await page.goto(`/photos/review?status=decided&q=${ingredientA!.slug}`);
  const approved = page.locator('li[data-state="approved"]');
  await expect(approved).toHaveCount(2);
  // Approvals in one group run side by side, so which of the two became the cover first is not fixed.
  const coverKey = (await libraryRows(ingredientA!.slug)).find((r) => r.cover)!.key;
  const [current, other] = coverKey === a1!.key ? [a1!, a2!] : [a2!, a1!];
  await expect(approved.filter({ hasText: current.title }).getByText("Approved, cover")).toBeVisible();
  await approved.filter({ hasText: other.title }).getByRole("button", { name: "Make cover", exact: true }).click();
  await expect(approved.filter({ hasText: other.title }).getByText("Approved, cover")).toBeVisible();
  expect((await libraryRows(ingredientA!.slug)).find((r) => r.cover)!.key).toBe(other.key);

  const removing = approved.filter({ hasText: current.title });
  await removing.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removing).toContainText("Remove this photo from the library?");
  await removing.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(approved).toHaveCount(2);
  await removing.getByRole("button", { name: "Remove", exact: true }).click();
  await removing.getByRole("button", { name: "Confirm remove", exact: true }).click();
  await expect(approved).toHaveCount(1);
  expect((await libraryRows(ingredientA!.slug)).map((r) => r.key)).toEqual([other.key]);
  // The removed photo's candidate is now a rejection that can be undone.
  await expect(page.locator('li[data-state="rejected"]').filter({ hasText: current.title })).toHaveCount(1);
});

test("phone layout: no sideways scroll at 320, 375 and 390 px, 44 px targets, and the action bar sits above the bottom navigation", async ({ page }) => {
  await blockRemoteImages(page);
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/photos/review");
    await expect(page.locator("input[data-ref]").first()).toBeVisible();
    await noHorizontalScroll(page);
    expect(await smallTargets(page, "main button, main a[href], main input:not([type=checkbox])")).toEqual([]);
    const heights = await page.locator("label:has(input[data-ref])").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Select first photo of each subject", exact: true }).click();
    await expect(bar(page)).toBeVisible();
    await noHorizontalScroll(page);
    expect(await smallTargets(page, 'main [role="region"] button')).toEqual([]);
    const geometry = await page.evaluate(() => {
      const barBox = document.querySelector('[role="region"][aria-label="Selection actions"]')!.getBoundingClientRect();
      const nav = [...document.querySelectorAll('nav[aria-label="Main"]')].map((el) => el.getBoundingClientRect()).find((box) => box.height > 0)!;
      return { barBottom: barBox.bottom, barHeight: barBox.height, navTop: nav.top, viewport: window.visualViewport!.height };
    });
    expect(geometry.barBottom).toBeLessThanOrEqual(geometry.navTop + 1);
    expect(geometry.barHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.navTop).toBeLessThanOrEqual(geometry.viewport);
    await bar(page).getByRole("button", { name: "Clear selection" }).click();
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/photos/review?status=decided");
  await expect(page.locator('li[data-state]').first()).toBeVisible();
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[href]")).toEqual([]);
});

test("keyboard only: Space toggles a tile with a visible focus ring, the bar opens the dialog, Escape returns focus", async ({ page }) => {
  await blockRemoteImages(page);
  await page.goto("/photos/review?kind=ingredient&missing=1");
  await expect(page.locator("input[data-ref]").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Search photos to review" }).focus();
  let focusedRef: string | null = null;
  for (let n = 0; n < 40 && !focusedRef; n++) {
    await page.keyboard.press("Tab");
    focusedRef = await page.evaluate(() => document.activeElement?.getAttribute("data-ref") ?? null);
  }
  expect(focusedRef, "Tab reaches a tile checkbox").not.toBeNull();
  const ring = await page.evaluate(() => {
    const label = document.activeElement!.closest("label")!;
    const style = getComputedStyle(label);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Space");
  await expect(status(page)).toHaveText("1 selected (1 ingredient)");
  await expect(page.locator(`input[data-ref="${focusedRef}"]`)).toBeChecked();
  await page.keyboard.press("Space");
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Space");
  const approve = bar(page).getByRole("button", { name: "Approve selected", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Approve 1 photo?" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();
  await bar(page).getByRole("button", { name: "Clear selection" }).click();
});

test("a signed-in member who is not a curator gets a 404 for the review page", async ({ browser }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const userId = randomUUID();
  const email = `review-non-curator-${randomUUID()}@example.test`;
  const password = "Synthetic-review-non-curator-password-123!";
  let personId: number | undefined;
  try {
    const [source] = await handle.db.select({ householdId: people.householdId }).from(people).where(eq(people.id, 300));
    await handle.db.insert(authUsers).values({ id: userId, name: "Synthetic review member", email, emailVerified: true });
    await handle.db.insert(authAccounts).values({ id: randomUUID(), userId, providerId: "credential", accountId: userId, password: await hashPassword(password) });
    const [profile] = await handle.db.insert(people).values({ householdId: source!.householdId!, name: "Synthetic review member profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] }).returning({ id: people.id });
    personId = profile!.id;
    await handle.db.insert(householdMembers).values({ householdId: source!.householdId!, userId, role: "member", personId });
    const context = await browser.newContext({ baseURL: origin });
    try {
      const signIn = await context.request.post("/api/auth/sign-in/email", { headers: { origin, "x-forwarded-for": "127.0.0.33" }, data: { email, password } });
      expect(signIn.status()).toBe(200);
      const denied = await context.newPage();
      for (const url of ["/photos/review", "/photos/review?status=decided", "/photos/review?kind=recipe&q=falafel"]) expect((await denied.goto(url))?.status(), url).toBe(404);
    } finally { await context.close(); }
  } finally {
    await handle.db.delete(authSessions).where(eq(authSessions.userId, userId));
    await handle.db.delete(householdMembers).where(eq(householdMembers.userId, userId));
    await handle.db.delete(authAccounts).where(eq(authAccounts.userId, userId));
    await handle.db.delete(authUsers).where(eq(authUsers.id, userId));
    if (personId) await handle.db.delete(people).where(eq(people.id, personId));
    await handle.close();
  }
});

test("clean up: remove the photos this file approved so later specs see the starting library", async ({ page }) => {
  await blockRemoteImages(page);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  let slugs: string[];
  try {
    slugs = [ingredientA!.slug, ingredientB!.slug];
    const rows = await handle.db.select({ id: libraryPhotos.id }).from(libraryPhotos).where(and(inArray(libraryPhotos.ingredientSlug, slugs)));
    expect(rows.length).toBeGreaterThan(0);
  } finally { await handle.close(); }
  for (const slug of slugs) {
    await page.goto(`/photos/review?status=decided&kind=ingredient&q=${slug}`);
    const approved = page.locator('li[data-state="approved"]');
    for (let left = await approved.count(); left > 0; left--) {
      await approved.first().getByRole("button", { name: "Remove", exact: true }).click();
      await approved.first().getByRole("button", { name: "Confirm remove", exact: true }).click();
      await expect(approved).toHaveCount(left - 1);
    }
    expect(await libraryRows(slug)).toHaveLength(0);
  }
  // The recipe photo approved above is removed too.
  await page.goto(`/photos/review?status=decided&kind=recipe&q=${recipeC!.slug}`);
  const approved = page.locator('li[data-state="approved"]');
  for (let left = await approved.count(); left > 0; left--) {
    await approved.first().getByRole("button", { name: "Remove", exact: true }).click();
    await approved.first().getByRole("button", { name: "Confirm remove", exact: true }).click();
    await expect(approved).toHaveCount(left - 1);
  }
});
