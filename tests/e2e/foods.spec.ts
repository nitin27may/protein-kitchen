import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Browser, Page, PlaywrightWorkerArgs } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createFsStore } from "../../lib/blob/fs";
import { openPostgres } from "../../lib/db/postgres/client";
import { authAccounts, authUsers, householdMembers, households, householdFoods, people, syncState } from "../../lib/db/schema";
import { attachFoodLabelPhoto, createHouseholdFood } from "../../lib/human/household-foods";
import { test, expect } from "./member-fixture";
import { noHorizontalScroll, smallTargets } from "./layout";
import { e2eTarget } from "./target";

const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}`;
const password = "Synthetic-foods-browser-password-123!";
const OWNER_EMAIL = "authorized-browser-fixture@example.test";
const NAME = "Kirkland pancake batter";

test.describe.configure({ mode: "serial" });

const label = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#f0e6c8" } })
  .composite([{ input: Buffer.from('<svg width="1600" height="1200" xmlns="http://www.w3.org/2000/svg"><text x="80" y="200" font-size="120" fill="#222">Nutrition Facts</text></svg>'), top: 0, left: 0 }])
  .jpeg().toBuffer();

/** A second account in the fixture household, with the member role. */
async function memberState(browser: Browser, playwright: PlaywrightWorkerArgs["playwright"]) {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const email = `foods-member-${randomUUID()}@example.test`;
  try {
    const [owner] = await handle.db.select({ householdId: householdMembers.householdId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId)).where(eq(authUsers.email, OWNER_EMAIL));
    const id = randomUUID();
    await handle.db.transaction(async (tx) => {
      await tx.insert(authUsers).values({ id, name: "Synthetic food member", email, emailVerified: true });
      await tx.insert(authAccounts).values({ id: randomUUID(), userId: id, providerId: "credential", accountId: id, password: await hashPassword(password) });
      const [profile] = await tx.insert(people).values({
        householdId: owner!.householdId, name: "Synthetic food member profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
      }).returning({ id: people.id });
      await tx.insert(householdMembers).values({ householdId: owner!.householdId, userId: id, role: "member", personId: profile!.id });
    });
  } finally { await handle.close(); }
  const client = await playwright.request.newContext({ baseURL: origin });
  try {
    const response = await client.post("/api/auth/sign-in/email", { headers: { origin, "x-forwarded-for": "127.0.0.47" }, data: { email, password } });
    expect(response.status()).toBe(200);
    return await browser.newContext({ storageState: await client.storageState(), viewport: { width: 412, height: 915 } });
  } finally { await client.dispose(); }
}

async function fillLabel(page: Page, values: { energy: string; protein: string; carbs: string; fat: string; fibre?: string; sugars?: string; sodium?: string }) {
  await page.getByLabel("Energy", { exact: true }).fill(values.energy);
  await page.getByLabel("Protein (g)", { exact: true }).fill(values.protein);
  await page.getByLabel("Carbohydrate (g)", { exact: true }).fill(values.carbs);
  await page.getByLabel("Fat (g)", { exact: true }).fill(values.fat);
  if (values.fibre) await page.getByLabel("Fibre (g)", { exact: true }).fill(values.fibre);
  if (values.sugars) await page.getByLabel("Sugars (g)", { exact: true }).fill(values.sugars);
  if (values.sodium) await page.getByLabel("Sodium", { exact: true }).fill(values.sodium);
}

let foodUid = "";

test("the owner adds a food from a per-serving label with a photo, and the kJ mistake needs a confirmation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/foods");
  await expect(page.getByRole("heading", { name: "Your foods", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Add a food", exact: true }).click();
  await expect(page).toHaveURL(/\/foods\/new$/);

  const save = page.getByRole("button", { name: "Save food", exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByRole("button", { name: "Take or choose photo" })).toBeEnabled();
  await page.getByTestId("label-photo-input").setInputFiles({ name: "label.jpg", mimeType: "image/jpeg", buffer: await label() });
  await expect(page.getByAltText("Photo of the nutrition label")).toBeVisible();
  await expect(page.getByText("New photo ready")).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill(NAME);
  await page.getByLabel("Brand", { exact: true }).fill("Kirkland Signature");
  await page.getByLabel("Barcode", { exact: true }).fill("9638 5074 x");
  await expect(page.getByLabel("Barcode", { exact: true })).toHaveValue("96385074");
  await page.getByLabel("Serving size", { exact: true }).fill("55");
  await page.getByLabel("Serving description", { exact: true }).fill("1/3 cup");

  // kJ typed in the kcal field: a warning, not an error, so saving needs the confirmation.
  await fillLabel(page, { energy: "377", protein: "2.5", carbs: "17", fat: "1", fibre: "0.5", sugars: "3", sodium: "230" });
  await expect(page.getByText("Looks like kJ, not kcal", { exact: false })).toBeVisible();
  await expect(save).toBeDisabled();
  const confirm = page.getByLabel("I checked these values against the label", { exact: true });
  await confirm.check();
  await expect(save).toBeEnabled();
  // Correcting the number removes the warning and the checkbox.
  await page.getByLabel("Energy", { exact: true }).fill("90");
  await expect(page.getByText("Looks like kJ, not kcal", { exact: false })).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  await expect(save).toBeEnabled();

  // The converted per-100 g values.
  const preview = page.getByTestId("per100g-preview");
  await expect(preview).toContainText("164 kcal");
  await expect(preview).toContainText("Fibre");
  await expect(preview).toContainText("One serving");
  await expect(preview).toContainText("55 g");
  await noHorizontalScroll(page);
  expect(await smallTargets(page, "main button, main a[href], main input:not([type=hidden]):not(.sr-only), main select")).toEqual([]);

  await page.getByLabel("Ingredients", { exact: true }).fill("Wheat flour, sugar, buttermilk powder, egg powder. May contain soy.");
  await expect(page.getByText("Contains egg (from ingredients)")).toBeVisible();
  await expect(page.getByLabel("Contains dairy")).toBeChecked();
  await page.getByLabel("Checked for our diet").check();

  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(origin));
  await save.click();
  expect((await saved).status()).toBe(200);
  await expect(page).toHaveURL(/\/foods\/[0-9a-f-]{36}\?saved=0$/);
  foodUid = new URL(page.url()).pathname.split("/")[2]!;
  await expect(page.getByRole("heading", { name: NAME, exact: true })).toBeVisible();
  await expect(page.getByText("From label, confirmed")).toBeVisible();
  await expect(page.getByText("Used in 0 entries")).toBeVisible();
  await expect(page.getByText("fibre", { exact: false }).first()).toBeVisible();
  const photo = page.getByAltText(`Nutrition label of ${NAME}`);
  await expect(photo).toBeVisible();
  expect(await photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await noHorizontalScroll(page);

  const stored = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [row] = await stored.db.select().from(householdFoods).where(eq(householdFoods.uid, foodUid));
    expect(row).toMatchObject({ name: NAME, source: "LABEL", barcode: "96385074", servingG: 55, labelBasis: "per_serving", isDairy: true, kcal: 163.6, proteinG: 4.55, carbsG: 30.91, fatG: 1.82, fibreG: 0.91 });
    expect(row!.dietFlagsFound).toEqual(["egg"]);
    expect(row!.dietCheckedAt).not.toBeNull();
    expect(row!.labelPhotoUid).not.toBeNull();
  } finally { await stored.close(); }

  const img = await page.request.get(`/foods/${foodUid}/label/thumb`);
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/webp");
  expect(img.headers()["cache-control"]).toBe("private, no-store");
});

test("the food is in the list and found by name, brand and barcode", async ({ page }) => {
  await page.goto("/foods");
  const row = page.getByRole("link", { name: new RegExp(NAME) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Per 100 g");
  await expect(row).toContainText("164 kcal");
  await expect(row).toContainText("From label, confirmed");
  const search = page.getByLabel("Search your foods");
  for (const query of ["pancake", "kirkland signature", "96385074"]) {
    await search.fill(query);
    await expect(row).toBeVisible();
  }
  await search.fill("zzzzz");
  await expect(page.getByText("No foods match")).toBeVisible();
  await search.fill("");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/foods/${foodUid}$`));
});

test("editing shows the printed numbers, a barcode clash is refused, and archive and delete work", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/foods/${foodUid}/edit`);
  await expect(page.getByLabel("Serving size", { exact: true })).toHaveValue("55");
  await expect(page.getByLabel("Energy", { exact: true })).toHaveValue("90");
  await expect(page.getByAltText("Photo of the nutrition label")).toBeVisible();
  await page.getByLabel("Protein (g)", { exact: true }).fill("3");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(origin));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/foods/${foodUid}\\?saved=0$`));
  await expect(page.getByText("From label, confirmed")).toBeVisible();

  const archive = page.getByRole("button", { name: "Archive", exact: true });
  await archive.click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await page.goto("/foods");
  await expect(page.getByRole("link", { name: new RegExp(NAME) })).toHaveCount(0);
  await page.getByLabel(/Show archived/).check();
  await expect(page.getByRole("link", { name: new RegExp(NAME) })).toContainText("Archived");
  await page.getByRole("link", { name: new RegExp(NAME) }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

  // A typed food (no photo) and a second one with the same barcode.
  await page.goto("/foods/new");
  await page.getByLabel("Name", { exact: true }).fill("Barcode clash");
  await page.getByLabel("Barcode", { exact: true }).fill("96385074");
  await expect(page.getByText("You already have a food with this barcode.")).toBeVisible();
  await page.getByLabel("Barcode", { exact: true }).fill("");
  await page.getByLabel("Serving size", { exact: true }).fill("30");
  await fillLabel(page, { energy: "120", protein: "6", carbs: "20", fat: "2" });
  await page.getByRole("button", { name: "Save food", exact: true }).click();
  await expect(page.getByText("Typed by you, no label")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete food", exact: true }).click();
  await expect(page).toHaveURL(/\/foods$/);
  await expect(page.getByText("Barcode clash")).toHaveCount(0);
});

test("a member sees the list and the food but has no way to add or edit", async ({ browser, playwright }) => {
  const context = await memberState(browser, playwright);
  try {
    const page = await context.newPage();
    await page.goto("/foods");
    await expect(page.getByRole("link", { name: new RegExp(NAME) })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a food", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(NAME) }).click();
    await expect(page.getByRole("heading", { name: NAME, exact: true })).toBeVisible();
    await expect(page.getByAltText(`Nutrition label of ${NAME}`)).toBeVisible();
    for (const name of ["Edit", "Archive", "Delete"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
    await page.goto("/foods/new");
    await expect(page).not.toHaveURL(/\/foods\/new$/);
    await page.goto(`/foods/${foodUid}/edit`);
    await expect(page).not.toHaveURL(/\/edit$/);
    expect((await page.request.get(`/foods/${foodUid}/label/master`)).status()).toBe(200);
  } finally { await context.close(); }
});

test("another household can open neither the food nor its label photo", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const householdId = `foreign-foods-${randomUUID()}`;
  let foreignUid = "";
  try {
    await handle.db.insert(households).values({ id: householdId, name: "Synthetic unrelated foods household" });
    const [profile] = await handle.db.insert(people).values({
      householdId, name: "Unrelated food profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: people.id });
    const scope = { householdId, personId: profile!.id };
    foreignUid = (await createHouseholdFood(handle.db, scope, {
      name: "Unrelated household secret food", kcal: 100, proteinG: 5, carbsG: 10, fatG: 1, labelBasis: "per_100g", source: "LABEL",
    })).uid;
    await attachFoodLabelPhoto(handle.db, createFsStore(process.env.UPLOADS_DIR ?? path.resolve("test-results/uploads")), scope, foreignUid, await label());

    expect((await page.goto(`/foods/${foreignUid}`))?.status()).toBe(404);
    expect((await page.goto(`/foods/${foreignUid}/edit`))?.status()).toBe(404);
    expect((await page.request.get(`/foods/${foreignUid}/label/master`)).status()).toBe(404);
    expect((await page.request.get(`/foods/${foreignUid}/label/thumb`)).status()).toBe(404);
    await page.goto("/foods");
    await expect(page.getByText("Unrelated household secret food")).toHaveCount(0);
    await page.getByLabel("Search your foods").fill("secret");
    await expect(page.getByText("Unrelated household secret food")).toHaveCount(0);
  } finally {
    await handle.db.delete(householdFoods).where(eq(householdFoods.householdId, householdId));
    await handle.db.delete(people).where(eq(people.householdId, householdId));
    await handle.db.delete(syncState).where(eq(syncState.householdId, householdId));
    await handle.db.delete(households).where(eq(households.id, householdId));
    await handle.close();
  }
});

test("a visitor with no session is sent to sign in and gets no label photo", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto("/foods");
    await expect(page).toHaveURL(/\/sign-in/);
    expect((await page.request.get(`/foods/${foodUid}/label/master`)).status()).toBe(401);
  } finally { await context.close(); }
});
