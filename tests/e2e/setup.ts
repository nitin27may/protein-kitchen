import path from "node:path";
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
    const recipe = [...data.recipes.values()].find((r) => r.kind === "recipe" && r.meal_slots.includes("dinner") && r.advance_prep.some((p) => p.lead_hours >= 4));
    if (!recipe) throw new Error("Browser fixture requires a dinner recipe with night-before prep.");
    const rows = await handle.db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes);
    const prepPlan = await persistNewPlan(handle.db, {
      setup: {
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

export default async function setup() {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [plan] = await handle.db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.seed, 12345));
    if (!plan) throw new Error("Browser server did not prepare the deterministic prep fixture.");
    process.env.E2E_PREP_PLAN_ID = String(plan.id);
  } finally { await handle.close(); }
}
