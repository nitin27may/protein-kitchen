import path from "node:path";
import { chromium, devices } from "@playwright/test";
import { eq, getTableName, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openPostgres } from "../../lib/db/postgres/client";
import * as s from "../../lib/db/schema";
import { seedDatabase } from "../../lib/db/seed";
import { loadData } from "../../lib/data/load";
import { readSqliteSnapshot } from "../../lib/db/sqlite-snapshot";
import { restoreSqliteSnapshot } from "../../lib/human/sqlite-restore";
import { persistNewPlan } from "../../lib/server/plan-persistence";
import { createSqliteSource } from "../helpers/sqlite-source";
import { seedLibraryPhoto } from "./library-photo-fixture";
import { e2eTarget } from "./target";

export async function prepareBrowserDatabase() {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  const source = createSqliteSource();
  try {
    await migrate(handle.db, { migrationsFolder: path.resolve("db/postgres-migrations") });
    await handle.db.execute(sql`truncate table ${sql.join(Object.values(s).map((table) => sql.identifier(getTableName(table))), sql`, `)} restart identity cascade`);
    await restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file));
    const data = loadData(process.cwd());
    await seedDatabase(handle.db, data);
    await seedLibraryPhoto(handle.db);
    const recipe = [...data.recipes.values()].find((r) => r.kind === "recipe" && r.meal_slots.includes("dinner") && r.advance_prep.some((p) => p.lead_hours >= 4));
    if (!recipe) throw new Error("Browser fixture requires a dinner recipe with night-before prep.");
    const rows = await handle.db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes);
    const [profile] = await handle.db.select({ householdId: s.people.householdId }).from(s.people).where(eq(s.people.id, 300));
    if (!profile?.householdId) throw new Error("Imported browser fixture must have explicit household ownership.");
    const prepPlan = await persistNewPlan(handle.db, {
      setup: {
        householdId: profile.householdId,
        personIds: [300], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true },
        prepStyle: "leftovers", createdAt: "2026-10-24T00:00:00.000Z",
      },
      seed: 12345, slots: [{
        date: "2026-11-04", slot: "dinner", recipeSlug: recipe.slug, servings: { 300: 1 }, locked: false, reasons: [],
      }], routines: [], recipeIds: new Map(rows.map((r) => [r.slug, r.id])),
    });
    return prepPlan;
  } finally {
    source.close();
    await handle.close();
  }
}

/**
 * `next dev` compiles each route, and its client bundle, on first request, and a compile can reload connected pages.
 * On a slow runner that happens in the middle of a journey: a form is reset or a click lands on a page that is about to
 * reload. Visiting every route once before the first test moves all of that cost out of the tests.
 */
async function warmRoutes(baseURL: string, prepPlanId: number) {
  const routes = [
    "/recipes", "/recipes/besan-oat-muffins", "/ingredients", "/credits", "/sign-in", "/sign-up", "/reset-password", "/verify-email",
    "/plan/new", "/plan/draft", "/plan", `/plan/${prepPlanId}`, `/plan/${prepPlanId}/prep`, "/groceries", "/onboarding", "/account",
    "/households", "/privacy", "/account-deleted", "/profiles", "/profiles/new", "/settings", "/photos/review", "/api/anon-library",
  ];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"], baseURL });
    const page = await context.newPage();
    for (const route of routes) {
      try { await page.goto(route, { waitUntil: "load", timeout: 90_000 }); await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined); }
      catch (error) { console.warn(`Warm-up of ${route} did not finish: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await context.close();
  } finally { await browser.close(); }
}

export default async function setup() {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [plan] = await handle.db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.seed, 12345));
    if (!plan) throw new Error("Browser server did not prepare the deterministic prep fixture.");
    process.env.E2E_PREP_PLAN_ID = String(plan.id);
    await warmRoutes(`http://127.0.0.1:${process.env.E2E_PORT ?? "3112"}`, plan.id);
  } finally { await handle.close(); }
}
