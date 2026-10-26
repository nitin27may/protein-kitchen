import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { devices, type BrowserContext, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { loadData } from "../../lib/data/load";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { createHouseholdFood } from "../../lib/human/household-foods";
import { persistNewPlan } from "../../lib/server/plan-persistence";
import { test, expect } from "./member-fixture";
import { smallTargets } from "./layout";
import { e2eTarget } from "./target";

const port = process.env.E2E_PORT ?? "3112";
const origin = `http://127.0.0.1:${port}`;
const today = new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const data = loadData(process.cwd());
const lunchRecipe = [...data.recipes.values()].find((r) => r.kind === "recipe" && r.meal_slots.includes("lunch"))!;
const dinnerRecipe = [...data.recipes.values()].find((r) => r.kind === "recipe" && r.meal_slots.includes("dinner") && r.slug !== lunchRecipe.slug)!;

const open = () => openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
type Handle = ReturnType<typeof open>;

let ownerPersonId: number;
let secondPersonId: number;
let memberPersonId: number;
let householdId: string;
let planId: number;
let lunchSlotId: number;
let dinnerSlotId: number;
let foodUid: string;
const memberEmail = "food-log-member@example.test";
const memberPassword = "Synthetic-food-log-member-password-123!";

async function logRows(handle: Handle) {
  return handle.db.select().from(s.foodLog).where(eq(s.foodLog.householdId, householdId));
}
async function lockedSlots(handle: Handle) {
  return (await handle.db.select({ id: s.planSlots.id, locked: s.planSlots.locked }).from(s.planSlots).where(eq(s.planSlots.planId, planId))).filter((x) => x.locked).map((x) => x.id);
}
const caption = (page: Page) => page.getByTestId("eaten-caption").first();
async function eatenNumbers(page: Page) {
  const text = (await caption(page).innerText()).trim();
  const m = /^Eaten (\d+) g, (?:(\d+) g still planned|nothing still planned), target (\d+) g$/.exec(text);
  expect(m, text).not.toBeNull();
  return { eaten: Number(m![1]), pending: Number(m![2] ?? 0), target: Number(m![3]) };
}
/** A navigation can be aborted by a refresh still in flight from the previous page: settle, then retry once. */
async function gotoPath(page: Page, path: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  try { await page.goto(path); } catch { await page.goto(path); }
}
const card = (page: Page, slot: string) => page.locator(`li[data-slot="${slot}"]`);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const handle = open();
  try {
    const [account] = await handle.db.select({ personId: s.householdMembers.personId, householdId: s.householdMembers.householdId })
      .from(s.householdMembers).innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId))
      .where(eq(s.authUsers.email, "authorized-browser-fixture@example.test"));
    if (!account?.personId || !account.householdId) throw new Error("The owner fixture must exist before the food log tests.");
    ownerPersonId = account.personId;
    householdId = account.householdId;
    const person = (name: string) => ({ householdId, name, sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [] });
    const [second] = await handle.db.insert(s.people).values(person("Food log second eater")).returning({ id: s.people.id });
    const [memberProfile] = await handle.db.insert(s.people).values(person("Food log member")).returning({ id: s.people.id });
    secondPersonId = second!.id;
    memberPersonId = memberProfile!.id;
    const memberId = randomUUID();
    await handle.db.insert(s.authUsers).values({ id: memberId, name: "Food log member", email: memberEmail, emailVerified: true });
    await handle.db.insert(s.authAccounts).values({ id: randomUUID(), userId: memberId, providerId: "credential", accountId: memberId, password: await hashPassword(memberPassword) });
    await handle.db.insert(s.householdMembers).values({ householdId, userId: memberId, role: "member", personId: memberPersonId });

    // A household food from the test database writer: this spec does not depend on the foods pages.
    foodUid = (await createHouseholdFood(handle.db, { householdId, personId: ownerPersonId }, {
      name: "Browser pancake mix", brand: "Costco", state: "ready", kcal: 345, proteinG: 7.3, carbsG: 70, fatG: 2, fibreG: null, servingLabel: "1/3 cup", servingG: 55,
      labelBasis: "per_serving", source: "LABEL", isDairy: false,
    })).uid;

    const recipeRows = await handle.db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes).where(inArray(s.recipes.slug, [lunchRecipe.slug, dinnerRecipe.slug]));
    planId = await persistNewPlan(handle.db, {
      setup: {
        householdId, personIds: [ownerPersonId, secondPersonId, memberPersonId], startDate: today, endDate: addDays(today, 6), mealTypes: ["lunch", "dinner"], cuisineBalance: 0.5, maxActiveMin: 30,
        healthFocus: { nutrientDense: false, lowSugar: true, light: true }, prepStyle: "variety", createdAt: new Date().toISOString(),
      },
      seed: 777, routines: [], recipeIds: new Map(recipeRows.map((r) => [r.slug, r.id])),
      slots: [
        { date: today, slot: "lunch", recipeSlug: lunchRecipe.slug, servings: { [ownerPersonId]: 1, [secondPersonId]: 1, [memberPersonId]: 1 }, locked: false, reasons: [] },
        { date: today, slot: "dinner", recipeSlug: dinnerRecipe.slug, servings: { [ownerPersonId]: 1, [secondPersonId]: 1, [memberPersonId]: 1 }, locked: false, reasons: [] },
        { date: addDays(today, 1), slot: "lunch", recipeSlug: lunchRecipe.slug, servings: { [ownerPersonId]: 1, [secondPersonId]: 1, [memberPersonId]: 1 }, locked: false, reasons: [] },
      ],
    });
    const slots = await handle.db.select().from(s.planSlots).where(eq(s.planSlots.planId, planId));
    lunchSlotId = slots.find((x) => x.date === today && x.slot === "lunch")!.id;
    dinnerSlotId = slots.find((x) => x.date === today && x.slot === "dinner")!.id;
  } finally { await handle.close(); }
});

test.afterAll(async () => {
  const handle = open();
  try {
    await handle.db.delete(s.foodLog).where(eq(s.foodLog.householdId, householdId));
    await handle.db.delete(s.plans).where(eq(s.plans.id, planId));
    await handle.db.delete(s.householdFoods).where(and(eq(s.householdFoods.uid, foodUid)));
    await handle.db.delete(s.authUsers).where(eq(s.authUsers.email, memberEmail));
    await handle.db.delete(s.people).where(inArray(s.people.id, [secondPersonId, memberPersonId]));
  } catch (error) { console.warn("Food log cleanup did not finish.", error); }
  finally { await handle.close(); }
});

test("an owner marks a planned meal eaten, the bar updates, and Undo puts it back", async ({ page }) => {
  await gotoPath(page, "/");
  const before = await eatenNumbers(page);
  expect(before.eaten).toBe(0);
  expect(before.pending).toBeGreaterThan(0);
  const lunch = card(page, "lunch");
  await expect(lunch.getByRole("button", { name: "Ate it", exact: true })).toBeEnabled();
  expect(await smallTargets(page, 'li[data-slot="lunch"] button')).toEqual([]);
  await lunch.getByRole("button", { name: "Ate it", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "as eaten." })).toBeVisible();
  await expect(lunch.getByTestId("meal-status")).toContainText("Ate it");
  await expect.poll(async () => (await eatenNumbers(page)).eaten).toBeGreaterThan(0);
  const after = await eatenNumbers(page);
  expect(after.pending).toBeLessThan(before.pending);
  const handle = open();
  try {
    expect(await logRows(handle)).toMatchObject([{ kind: "planned", personId: ownerPersonId, slot: "lunch", recipeSlug: lunchRecipe.slug }]);
    expect(await lockedSlots(handle)).toEqual([lunchSlotId]);
  } finally { await handle.close(); }

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(lunch.getByRole("button", { name: "Ate it", exact: true })).toBeVisible();
  await expect.poll(async () => (await eatenNumbers(page)).eaten).toBe(0);
  const restored = open();
  try {
    expect(await logRows(restored)).toEqual([]);
    expect(await lockedSlots(restored)).toEqual([]);
  } finally { await restored.close(); }
});

test("an extra from a household food is added to lunch, shown with its protein, and Undo removes it", async ({ page }) => {
  await gotoPath(page, "/");
  await card(page, "lunch").getByRole("button", { name: "Add to lunch", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add food" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("searchbox", { name: "Search foods and recipes" }).fill("pancake");
  const result = sheet.getByRole("button", { name: /Browser pancake mix/ });
  await expect(result).toBeVisible();
  await expect(result).toContainText("Your food");
  await result.click();
  await expect(sheet.getByTestId("live-line")).toHaveText(/^1 serving \(55 g\) · \d+ g protein · \d+ kcal · fibre not reported$/);
  await expect(sheet.getByRole("button", { name: "Lunch", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  const toast = page.getByRole("status").filter({ hasText: "Added Browser pancake mix to lunch." });
  await expect(toast).toBeVisible();
  const lunch = card(page, "lunch");
  await expect(lunch.getByRole("list", { name: "Also eaten at lunch" })).toContainText("Browser pancake mix");
  const handle = open();
  try {
    expect(await logRows(handle)).toMatchObject([{ kind: "extra", personId: ownerPersonId, slot: "lunch", grams: 55, displayQty: 1, displayUnit: "serving", date: today }]);
  } finally { await handle.close(); }
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(lunch.getByRole("list", { name: "Also eaten at lunch" })).toHaveCount(0);
  const gone = open();
  try { expect(await logRows(gone)).toEqual([]); } finally { await gone.close(); }
});

test("yesterday is one tap away, shows Not logged, and takes a past extra for two people", async ({ page }) => {
  await gotoPath(page, "/");
  await page.getByRole("link", { name: "Yesterday", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`d=${addDays(today, -1)}`));
  await expect(page.getByText("Not logged").first()).toBeVisible();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add food" });
  await sheet.getByRole("searchbox", { name: "Search foods and recipes" }).fill("pancake");
  await sheet.getByRole("button", { name: /Browser pancake mix/ }).click();
  await expect(sheet.getByRole("button", { name: "Yesterday", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Food log second eater", exact: true }).click();
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added Browser pancake mix to" })).toBeVisible();
  const handle = open();
  try {
    const rows = await logRows(handle);
    expect(rows.map((r) => r.personId).sort()).toEqual([ownerPersonId, secondPersonId].sort());
    expect(rows.every((r) => r.date === addDays(today, -1) && r.kind === "extra" && r.grams === 55)).toBe(true);
    await handle.db.delete(s.foodLog).where(eq(s.foodLog.householdId, householdId));
  } finally { await handle.close(); }
});

test("regenerating the plan keeps the eaten slot, and plan review shows eaten against planned", async ({ page }) => {
  await gotoPath(page, "/");
  await card(page, "dinner").getByRole("button", { name: "Ate it", exact: true }).click();
  await expect(card(page, "dinner").getByTestId("meal-status")).toContainText("Ate it");
  await gotoPath(page, `/plan/${planId}`);
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.getByText("New plan made. Locked meals were kept.")).toBeVisible();
  const handle = open();
  try {
    expect(await lockedSlots(handle)).toContain(dinnerSlotId);
    const [slot] = await handle.db.select().from(s.planSlots).where(eq(s.planSlots.id, dinnerSlotId));
    expect(slot).toMatchObject({ locked: true });
  } finally { await handle.close(); }
  const today1 = page.getByRole("complementary", { name: "Protein today" });
  await expect(today1.getByText("Eaten against planned")).toBeVisible();
  await expect(today1.getByTestId("eaten-summary").first()).toContainText("Eaten protein: 1 of 7 days logged, average");
  await expect(today1.getByText("Part logged").first()).toBeVisible();
  await gotoPath(page, "/");
  await expect(card(page, "dinner").getByTestId("meal-status")).toContainText("Ate it");
  await page.getByRole("button", { name: /Mark the rest of today as eaten as planned/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Marked \d+ meals? as eaten\./ })).toBeVisible();
  await expect(card(page, "lunch").getByTestId("meal-status")).toContainText("Ate it");
  await expect(page.getByRole("button", { name: /Mark the rest of today/ })).toHaveCount(0);
});

test("a member sees only themselves, cannot log for another person, and the server refuses a forged request", async ({ browser }) => {
  const client = await (await import("@playwright/test")).request.newContext({ baseURL: origin });
  let context: BrowserContext | undefined;
  try {
    const signIn = await client.post("/api/auth/sign-in/email", { headers: { origin, "x-forwarded-for": "127.0.0.47" }, data: { email: memberEmail, password: memberPassword } });
    expect(signIn.status()).toBe(200);
    context = await browser.newContext({ ...devices["Pixel 7"], baseURL: origin, storageState: await client.storageState() });
    const page = await context.newPage();
    await page.goto(`/?p=${ownerPersonId}`);
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByText("Food log member:", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Person" })).toHaveCount(0);
    await page.getByRole("button", { name: "Add food", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add food" });
    await sheet.getByRole("searchbox", { name: "Search foods and recipes" }).fill("pancake");
    await sheet.getByRole("button", { name: /Browser pancake mix/ }).click();
    await expect(sheet.getByText("Who ate it")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close Add food" }).click();

    const capturing = page.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
    await card(page, "lunch").getByRole("button", { name: "Ate it", exact: true }).click();
    const captured = await capturing;
    await expect(card(page, "lunch").getByTestId("meal-status")).toContainText("Ate it");
    const headers = { origin, "content-type": captured.headers()["content-type"]!, "next-action": captured.headers()["next-action"]! };
    const forged = await page.request.post("/", { headers, data: JSON.stringify([{ personId: ownerPersonId, planSlotId: dinnerSlotId }]) });
    expect(await forged.text()).toContain("You can only change your own profile and routine choices.");
    const own = await page.request.post("/", { headers, data: JSON.stringify([{ personId: memberPersonId, planSlotId: dinnerSlotId }]) });
    expect(await own.text()).toContain('"ok":true');
    const handle = open();
    try {
      const rows = await handle.db.select().from(s.foodLog).where(eq(s.foodLog.personId, memberPersonId));
      expect(rows.length).toBe(2);
      expect((await logRows(handle)).filter((r) => r.createdByPersonId === memberPersonId && r.personId !== memberPersonId)).toEqual([]);
    } finally { await handle.close(); }
  } finally {
    await context?.close();
    await client.dispose();
  }
});

test("a visitor without an account sees no food log controls", async ({ browser }) => {
  // An explicit empty state: the fixture would otherwise sign this context in.
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: origin, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await gotoPath(page, "/");
    await expect(page.getByRole("button", { name: "Add food" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ate it" })).toHaveCount(0);
  } finally { await context.close(); }
});
