import { expect, test } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { readSqliteSnapshot } from "../../lib/db/sqlite-snapshot";
import { personKey } from "../../lib/human/routines";
import { stableJson } from "../../lib/human/util";
import { buildLegacyBundle, countBundle, dataChecksum } from "../../lib/legacy/bundle";
import { createLegacySource } from "../helpers/legacy-source";
import { noHorizontalScroll, smallTargets } from "./layout";
import { e2eTarget } from "./target";

const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}`;
const password = "Synthetic-legacy-import-password-123!";

/**
 * A new account in its own empty household, the way a signed-up owner starts, imports a synthetic bundle generated here
 * from a synthetic SQLite file. The journey is the same one the owner follows: file, dry run, link, commit, refusal.
 */
test("an owner checks a bundle, sees the dry run, imports it into their own household once, and cannot import it again", async ({ page, playwright }) => {
  test.setTimeout(180_000);
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const source = createLegacySource();
  const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-e2e-"));
  const email = `legacy-owner-${randomUUID()}@example.test`;
  const householdId = randomUUID();
  const userId = randomUUID();
  try {
    // Real library slugs where the synthetic file has stand-ins, so the dry run shows both imported and left-out rows.
    const bundle = buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans: false, renames: { fixture: "besan-oat-muffins" }, now: () => new Date("2026-10-25T00:00:00Z") });
    // The shared browser database already holds the base fixture's uids in another household, which the importer refuses.
    const tag = randomUUID().slice(0, 8);
    for (const rows of [bundle.data.recipe_feedback, bundle.data.recipe_links, bundle.data.saved_views, bundle.data.person_routines]) {
      for (const row of rows) row.uid = `${row.uid}-${tag}`;
    }
    bundle.manifest.counts = countBundle(bundle.data);
    bundle.manifest.sha256 = dataChecksum(bundle.data);
    const file = path.join(directory, "bundle.json");
    await writeFile(file, stableJson(bundle));
    const tampered = path.join(directory, "tampered.json");
    await writeFile(tampered, stableJson({ ...bundle, data: { ...bundle.data, people: bundle.data.people.map((p) => ({ ...p, name: "Changed" })) } }));

    const before = (await handle.db.select().from(s.people)).length;
    await handle.db.transaction(async (tx) => {
      await tx.insert(s.households).values({ id: householdId, name: "Legacy import household" });
      await tx.insert(s.authUsers).values({ id: userId, name: "Legacy import owner", email, emailVerified: true });
      await tx.insert(s.authAccounts).values({ id: randomUUID(), userId, providerId: "credential", accountId: userId, password: await hashPassword(password) });
      const [profile] = await tx.insert(s.people).values({
        householdId, name: "Starter profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
      }).returning({ id: s.people.id });
      await tx.insert(s.householdMembers).values({ householdId, userId, role: "owner", personId: profile!.id });
    });
    const client = await playwright.request.newContext({ baseURL: origin });
    const response = await client.post("/api/auth/sign-in/email", { headers: { origin, "x-forwarded-for": "127.0.0.77" }, data: { email, password } });
    expect(response.status()).toBe(200);
    const cookies = (await client.storageState()).cookies;
    await client.dispose();
    await page.context().addCookies(cookies);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/settings");
    const panel = page.getByRole("region", { name: "Import from the old app" });
    await expect(panel.getByRole("heading", { name: "Import from the old app" })).toBeVisible();
    await noHorizontalScroll(page);

    // A changed file is refused before anything is shown.
    await panel.getByLabel("Bundle file").setInputFiles(tampered);
    await panel.getByRole("button", { name: "Check the bundle" }).click();
    await expect(panel.getByText("checksum does not match")).toBeVisible();

    await panel.getByLabel("Bundle file").setInputFiles(file);
    await panel.getByRole("button", { name: "Check the bundle" }).click();
    const result = panel.getByLabel("Dry run result");
    await expect(result.getByText("Dry run: nothing has been imported yet")).toBeVisible();
    await expect(result.getByRole("row", { name: /^People 2 0$/ })).toBeVisible();
    await expect(result.getByRole("row", { name: /^Ratings and notes 1 2$/ })).toBeVisible();
    await expect(result.getByText(/Not in this app's library, so left out \(recipes\): .*gone-recipe/)).toBeVisible();
    expect((await handle.db.select().from(s.people)).length).toBe(before + 1);
    expect(await smallTargets(page, "#legacy-bundle, #legacy-link, section[aria-label='Import from the old app'] button")).toEqual([]);
    await noHorizontalScroll(page);
    await page.screenshot({ path: "test-results/legacy-import-dry-run.png", fullPage: true });

    await result.getByLabel("Which person are you?").selectOption({ label: "Synthetic import fixture" });
    await result.getByRole("button", { name: "Import into this household" }).click();
    await expect(panel.getByRole("status")).toContainText("Import finished");

    const mine = await handle.db.select().from(s.people).where(eq(s.people.householdId, householdId));
    expect(mine.map((p) => p.name).sort()).toEqual(["Second synthetic cook", "Synthetic import fixture"]);
    const [member] = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, userId));
    expect(member!.personId).toBe(mine.find((p) => personKey(p.name, p.birthDate) === personKey("Synthetic import fixture", "2000-02-29"))!.id);
    const feedback = (await handle.db.select().from(s.recipeFeedback)).filter((r) => r.householdId === householdId);
    expect(feedback.map((r) => r.uid).sort()).toContain(`feedback-fixture-${tag}`);
    expect((await handle.db.select().from(s.syncState)).filter((r) => r.householdId === householdId)).toEqual([]);

    // Running it again is refused and changes nothing.
    await panel.getByRole("button", { name: "Import another bundle" }).click();
    await panel.getByLabel("Bundle file").setInputFiles(file);
    await panel.getByRole("button", { name: "Check the bundle" }).click();
    await expect(panel.getByText("already been imported")).toBeVisible();
    expect((await handle.db.select().from(s.people).where(eq(s.people.householdId, householdId))).length).toBe(2);
  } finally {
    // Remove only this test's rows so the shared browser database keeps its other fixtures.
    await handle.db.delete(s.householdMembers).where(eq(s.householdMembers.householdId, householdId)).catch(() => undefined);
    for (const table of [s.recipeFeedback, s.recipeLinks, s.savedViews, s.pantry, s.people]) {
      await handle.db.delete(table).where(eq(table.householdId, householdId)).catch(() => undefined);
    }
    await handle.db.delete(s.authUsers).where(eq(s.authUsers.id, userId)).catch(() => undefined);
    await handle.db.delete(s.households).where(eq(s.households.id, householdId)).catch(() => undefined);
    await handle.close();
    source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
