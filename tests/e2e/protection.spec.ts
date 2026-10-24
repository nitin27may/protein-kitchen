import { test, expect } from "./member-fixture";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { openPostgres } from "../../lib/db/postgres/client";
import { authUsers, householdMembers, households, people, personRecipeFeedback, recipes, plans, planSetups, planSlots } from "../../lib/db/schema";
import { e2eTarget } from "./target";
import { persistNewPlan } from "../../lib/server/plan-persistence";

test("owners cannot read or mutate another household's newer plan, prep, groceries or exports", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const householdId = `foreign-plan-${randomUUID()}`;
  let personId: number | undefined;
  let setupId: number | undefined;
  let planId: number | undefined;
  let restoreLock: { id: number; locked: boolean } | undefined;
  try {
    await handle.db.insert(households).values({ id: householdId, name: "Unrelated synthetic plan household" });
    const [person] = await handle.db.insert(people).values({
      householdId, name: "Foreign private plan profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: people.id });
    personId = person!.id;
    const [recipe] = await handle.db.select({ id: recipes.id }).from(recipes).where(eq(recipes.slug, "tofu-burrito-bowl"));
    planId = await persistNewPlan(handle.db, {
      setup: {
        householdId, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true },
        prepStyle: "leftovers", createdAt: new Date().toISOString(),
      },
      seed: 1942, slots: [{
        date: "2026-11-04", slot: "dinner", recipeSlug: "tofu-burrito-bowl", servings: { [personId]: 1 },
        locked: false, reasons: [],
      }], routines: [], recipeIds: new Map([["tofu-burrito-bowl", recipe!.id]]),
    });
    setupId = (await handle.db.select().from(plans).where(eq(plans.id, planId)))[0]!.setupId;
    const [ownedSlot] = await handle.db.select().from(planSlots).where(eq(planSlots.planId, Number(process.env.E2E_PREP_PLAN_ID))).limit(1);
    const [foreignSlot] = await handle.db.select().from(planSlots).where(eq(planSlots.planId, planId)).limit(1);
    restoreLock = { id: ownedSlot!.id, locked: ownedSlot!.locked };
    await page.goto(`/plan/${process.env.E2E_PREP_PLAN_ID}`);
    const weekday = new Date(`${ownedSlot!.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    await page.getByRole("tab", { name: `${weekday} ${ownedSlot!.date.slice(-2)}`, exact: true }).click();
    const capturing = page.waitForRequest((request) => request.method() === "POST" && request.headers()["next-action"] !== undefined);
    await page.getByRole("button", { name: ownedSlot!.locked ? "Locked" : "Lock", exact: true }).first().click();
    const captured = await capturing;
    await page.waitForLoadState("networkidle");
    const replay = await page.request.post(`/plan/${process.env.E2E_PREP_PLAN_ID}`, {
      headers: {
        origin: "http://127.0.0.1:3112", "content-type": captured.headers()["content-type"]!,
        "next-action": captured.headers()["next-action"]!,
      },
      data: JSON.stringify([planId, foreignSlot!.id, true]),
    });
    expect(await replay.text()).toContain("not available in your household");
    expect((await handle.db.select().from(planSlots).where(eq(planSlots.id, foreignSlot!.id)))[0]!.locked).toBe(false);
    for (const path of [`/plan/${planId}`, `/plan/${planId}/prep`]) {
      expect((await page.goto(path))?.status()).toBe(404);
      await expect(page.getByText("Foreign private plan profile", { exact: true })).toHaveCount(0);
      const rsc = await page.request.get(path, { headers: { rsc: "1" } });
      expect(await rsc.text()).not.toContain("Foreign private plan profile");
    }
    await page.goto(`/groceries?plan=${planId}`);
    await expect(page.getByRole("heading", { name: "No list yet", exact: true })).toBeVisible();
    for (const format of ["xlsx", "pdf"]) {
      const response = await page.request.get(`/api/plan/${planId}/export?format=${format}`);
      expect(response.status()).toBe(404);
      expect(await response.json()).toMatchObject({ error: "Plan not found" });
    }
    await page.goto("/");
    await expect(page.locator(`a[href="/plan/${planId}"]`)).toHaveCount(0);
    await page.goto("/plan/new?step=who");
    await expect(page.getByText("Foreign private plan profile", { exact: true })).toHaveCount(0);
  } finally {
    if (restoreLock) await handle.db.update(planSlots).set({ locked: restoreLock.locked }).where(eq(planSlots.id, restoreLock.id));
    if (planId) await handle.db.delete(plans).where(eq(plans.id, planId));
    if (setupId) await handle.db.delete(planSetups).where(eq(planSetups.id, setupId));
    if (personId) await handle.db.delete(people).where(eq(people.id, personId));
    await handle.db.delete(households).where(eq(households.id, householdId));
    await handle.close();
  }
});

test("profile Server Actions persist household ownership and reject foreign profile edits even for owners", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const foreignHouseholdId = `foreign-${randomUUID()}`;
  const createdIds: number[] = [];
  try {
    const [account] = await handle.db.select({ personId: householdMembers.personId, householdId: householdMembers.householdId })
      .from(householdMembers).innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(eq(authUsers.email, "authorized-browser-fixture@example.test"));
    expect(account?.householdId).toBeTruthy();
    await handle.db.insert(households).values({ id: foreignHouseholdId, name: "Synthetic unrelated household" });
    const [foreign] = await handle.db.insert(people).values({
      householdId: foreignHouseholdId, name: "Unrelated synthetic profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: people.id });
    createdIds.push(foreign!.id);
    await handle.db.insert(authUsers).values({
      id: foreignHouseholdId, name: "Unrelated synthetic account", email: `${foreignHouseholdId}@example.test`, emailVerified: true,
    });
    await handle.db.insert(householdMembers).values({
      householdId: foreignHouseholdId, userId: foreignHouseholdId, personId: foreign!.id, role: "owner",
    });
    await page.goto("/profiles");
    await expect(page.getByText("Unrelated synthetic profile", { exact: true })).toHaveCount(0);
    expect((await page.goto(`/profiles/${foreign!.id}`))?.status()).toBe(404);
    await page.goto("/account");
    await expect(page.getByText(`${foreignHouseholdId}@example.test`, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Unrelated synthetic profile", { exact: true })).toHaveCount(0);
    await page.goto(`/profiles/${account!.personId}`);
    const outgoing = page.waitForRequest((request) => request.method() === "POST" && request.headers()["next-action"] !== undefined);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const request = await outgoing;
    await page.waitForLoadState("networkidle");
    const [profile] = z.tuple([z.object({ id: z.number(), name: z.string() }).passthrough()]).parse(JSON.parse(request.postData()!));
    const headers = { origin: "http://127.0.0.1:3112", "content-type": request.headers()["content-type"]!, "next-action": request.headers()["next-action"]! };
    const foreignAttempt = await page.request.post(`/profiles/${account!.personId}`, {
      headers, data: JSON.stringify([{ ...profile, id: foreign!.id, name: "Must never persist" }]),
    });
    expect(await foreignAttempt.text()).toContain("not in this household");
    expect(await handle.db.select({ name: people.name }).from(people).where(eq(people.id, foreign!.id)))
      .toEqual([{ name: "Unrelated synthetic profile" }]);
    const name = `Owned fixture ${randomUUID()}`;
    const newProfile = { ...profile, name };
    Reflect.deleteProperty(newProfile, "id");
    const response = await page.request.post("/profiles/new", { headers, data: JSON.stringify([newProfile]) });
    expect(response.status()).toBe(200);
    const [created] = await handle.db.select().from(people).where(eq(people.name, name));
    if (created) createdIds.push(created.id);
    expect(created).toMatchObject({ householdId: account!.householdId });
    const update = await page.request.post(`/profiles/${created!.id}`, {
      headers, data: JSON.stringify([{ ...newProfile, id: created!.id, name: `${name} updated` }]),
    });
    expect(update.status()).toBe(200);
    expect(await handle.db.select({ name: people.name, householdId: people.householdId }).from(people).where(eq(people.id, created!.id)))
      .toEqual([{ name: `${name} updated`, householdId: account!.householdId }]);
    await page.goto(`/profiles/${created!.id}`);
    await page.reload();
    await expect(page.getByRole("heading", { name: `${name} updated`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete profile", exact: true }).click();
    const deleting = page.waitForRequest((pending) => pending.method() === "POST" && pending.headers()["next-action"] !== undefined);
    await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
    const deletion = await deleting;
    await expect(page).toHaveURL(/\/profiles$/);
    expect(await handle.db.select().from(people).where(eq(people.id, created!.id))).toEqual([]);
    const foreignDeletion = await page.request.post("/profiles", {
      headers: { origin: headers.origin, "content-type": deletion.headers()["content-type"]!, "next-action": deletion.headers()["next-action"]! },
      data: JSON.stringify([foreign!.id]),
    });
    expect(await foreignDeletion.text()).toContain("not in this household");
    expect(await handle.db.select().from(people).where(eq(people.id, foreign!.id))).toHaveLength(1);
  } finally {
    await handle.db.delete(authUsers).where(eq(authUsers.id, foreignHouseholdId));
    for (const id of createdIds) await handle.db.delete(people).where(eq(people.id, id));
    await handle.db.delete(households).where(eq(households.id, foreignHouseholdId));
    await handle.close();
  }
});

test("anonymous pages, server components, photo bytes and exports never disclose household data", async ({ browser }) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await anonymous.newPage();
    expect(await anonymous.cookies()).toEqual([]);
    for (const url of ["/profiles", "/groceries", "/photos/review", `/plan/${process.env.E2E_PREP_PLAN_ID}/prep`]) {
      await page.goto(`http://127.0.0.1:3112${url}`);
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    }
    for (const url of [
      "/api/account/export",
      `/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`,
      `/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=xlsx`,
      "/photos/00000000-0000-4000-8000-000000000001/thumb",
      "/api/push/subscribe?personId=300&endpoint=private",
    ]) {
      const response = await anonymous.request.get(`http://127.0.0.1:3112${url}`);
      expect(response.status()).toBe(401);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.text()).not.toContain("Synthetic import fixture");
    }
    const rsc = await anonymous.request.get("http://127.0.0.1:3112/profiles", { headers: { RSC: "1" } });
    expect(rsc.headers()["cache-control"]).toContain("no-store");
    expect(await rsc.text()).not.toContain("Synthetic import fixture");
  } finally { await anonymous.close(); }
});

test("captured feedback actions cannot select another person's rating, even for an owner", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [member] = await handle.db.select({ personId: householdMembers.personId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId)).where(eq(authUsers.email, "authorized-browser-fixture@example.test"));
    const personId = member!.personId!;
    const [foreign] = await handle.db.select({ id: people.id }).from(people).where(ne(people.id, personId)).limit(1);
    const [recipe] = await handle.db.select({ id: recipes.id }).from(recipes).where(eq(recipes.slug, "tofu-burrito-bowl"));
    const before = await handle.db.select().from(personRecipeFeedback).where(eq(personRecipeFeedback.personId, foreign!.id));
    await page.goto("/recipes/tofu-burrito-bowl");
    const captured = page.waitForRequest((request) => request.method() === "POST" && request.headers()["next-action"] !== undefined);
    await page.getByRole("button", { name: "Favourite", exact: true }).click();
    const request = await captured;
    await expect(page.getByRole("button", { name: "Favourite", exact: true })).toBeEnabled();
    const headers = { origin: "http://127.0.0.1:3112", "content-type": request.headers()["content-type"]!, "next-action": request.headers()["next-action"]! };
    const forged = await page.request.post("/recipes/tofu-burrito-bowl", {
      headers, data: JSON.stringify(["tofu-burrito-bowl", { rating: 1, personId: foreign!.id }]),
    });
    expect(await forged.text()).toContain("Unrecognized key");
    const injectedDownload = await page.request.get(`/api/account/export?personId=${foreign!.id}`);
    expect(injectedDownload.status()).toBe(400);
    expect(injectedDownload.headers()["cache-control"]).toContain("no-store");
    const extraArgument = await page.request.post("/recipes/tofu-burrito-bowl", {
      headers, data: JSON.stringify(["tofu-burrito-bowl", { rating: 3 }, foreign!.id]),
    });
    expect(await extraArgument.text()).toContain('"ok":true');
    expect(await handle.db.select().from(personRecipeFeedback).where(and(eq(personRecipeFeedback.personId, personId), eq(personRecipeFeedback.recipeId, recipe!.id))))
      .toMatchObject([{ rating: 3 }]);
    expect(await handle.db.select().from(personRecipeFeedback).where(eq(personRecipeFeedback.personId, foreign!.id))).toEqual(before);
  } finally { await handle.close(); }
});

test("captured Server Actions cannot edit another profile or survive revoked household membership", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [account] = await handle.db.select({ userId: householdMembers.userId, personId: householdMembers.personId, householdId: householdMembers.householdId })
      .from(householdMembers).innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(eq(authUsers.email, "authorized-browser-fixture@example.test"));
    expect(account?.personId).toBeTruthy();
    const personId = account!.personId!;
    const [foreign] = await handle.db.select({ id: people.id, name: people.name }).from(people).where(ne(people.id, personId)).limit(1);
    expect(foreign).toBeTruthy();
    await handle.db.update(householdMembers).set({ role: "member" }).where(eq(householdMembers.userId, account!.userId));
    try {
      await page.goto(`/profiles/${personId}`);
      const outgoing = page.waitForRequest((req) => req.method() === "POST" && req.headers()["next-action"] !== undefined);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const submitted = await outgoing;
      await page.waitForLoadState("networkidle");
      const body = submitted.postData();
      expect(body).toBeTruthy();
      const [profile] = z.tuple([z.object({ id: z.number(), name: z.string() }).passthrough()]).parse(JSON.parse(body!));
      expect(profile.id).toBe(personId);
      const headers = { origin: "http://127.0.0.1:3112", "content-type": submitted.headers()["content-type"]!, "next-action": submitted.headers()["next-action"]! };
      const foreignAttempt = await page.request.post(`/profiles/${personId}`, {
        headers, data: JSON.stringify([{ ...profile, id: foreign!.id, name: "Must never be saved" }]),
      });

      expect(await foreignAttempt.text()).toContain("only change your own profile");
      expect(await handle.db.select({ name: people.name }).from(people).where(eq(people.id, foreign!.id))).toEqual([{ name: foreign!.name }]);
      await handle.db.delete(householdMembers).where(eq(householdMembers.userId, account!.userId));
      const replay = await page.request.post(`/profiles/${personId}`, { headers, data: body! });
      expect(await replay.text()).toContain("Finish household and profile onboarding");
      const exportResult = await page.request.get(`/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`);
      expect(exportResult.status()).toBe(403);
      expect(exportResult.headers()["cache-control"]).toContain("no-store");
      const revokedDownload = await page.request.get("/api/account/export");
      expect(revokedDownload.status()).toBe(403);
      expect(revokedDownload.headers()["cache-control"]).toContain("no-store");
      await page.goto("/groceries");
      await expect(page).toHaveURL(/\/onboarding/);
    } finally {
      await handle.db.insert(householdMembers).values({ householdId: account!.householdId, userId: account!.userId, personId, role: "owner" })
        .onConflictDoUpdate({ target: householdMembers.userId, set: { householdId: account!.householdId, role: "owner", personId } });
      expect(await handle.db.select().from(householdMembers).where(and(eq(householdMembers.userId, account!.userId), eq(householdMembers.personId, personId)))).toHaveLength(1);
    }
  } finally { await handle.close(); }
});

test("a cook can validate, save, reload and privately export their reminder timezone", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [account] = await handle.db.select({ personId: householdMembers.personId }).from(householdMembers)
      .innerJoin(authUsers, eq(authUsers.id, householdMembers.userId)).where(eq(authUsers.email, "authorized-browser-fixture@example.test"));
    const personId = account!.personId!;
    const [before] = await handle.db.select().from(people).where(eq(people.id, personId));
    try {
      await page.goto(`/profiles/${personId}`);
      await page.getByLabel("Prep reminder time (optional)", { exact: true }).fill("21:00");
      const timezone = page.getByLabel("Reminder time zone (optional)", { exact: true });
      await timezone.fill("Invalid/Timezone");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(timezone).toHaveAttribute("aria-invalid", "true");
      expect((await handle.db.select().from(people).where(eq(people.id, personId)))[0]!.reminderTimezone).toBe(before!.reminderTimezone);
      await timezone.fill("Asia/Kolkata");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page).toHaveURL(/\/profiles$/);
      await page.goto(`/profiles/${personId}`);
      await expect(timezone).toHaveValue("Asia/Kolkata");
      const download = await page.request.get("/api/account/export");
      expect(download.status()).toBe(200);
      expect(await download.json()).toMatchObject({ profile: { reminderTime: "21:00", reminderTimezone: "Asia/Kolkata" } });
      await page.screenshot({ path: "test-results/reminder-timezone-phone.png", fullPage: true });
      await timezone.fill("");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page).toHaveURL(/\/profiles$/);
      await page.goto(`/profiles/${personId}`);
      await expect(timezone).toHaveValue("");
      expect((await handle.db.select().from(people).where(eq(people.id, personId)))[0]!.reminderTimezone).toBeNull();
    } finally {
      await handle.db.update(people).set({ reminderTime: before!.reminderTime, reminderTimezone: before!.reminderTimezone }).where(eq(people.id, personId));
    }
  } finally { await handle.close(); }
});
