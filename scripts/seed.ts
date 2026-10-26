import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "../lib/data/load";
import { openVerifiedPostgres } from "../lib/db/postgres/verified-client";
import { postgresMigrationTarget } from "../lib/db/postgres/migration-target";
import { shouldInitializeFeedback } from "../lib/db/postgres/seed-target";
import { seedDatabase } from "../lib/db/seed";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = postgresMigrationTarget(process.env);

const data = loadData(root);
if (data.issues.length) {
  for (const i of data.issues) console.error(`${i.file}: ${i.message}`);
  process.exit(1);
}

const handle = await openVerifiedPostgres(target);
let report;
try {
  report = await seedDatabase(handle.db, data, { initializeFeedback: shouldInitializeFeedback(target) });
} finally {
  await handle.close();
}

console.log(`Seeded the explicitly configured ${target.databaseEnvironment} Postgres library.`);
console.log(`  ingredients ${report.ingredients}, recipes+components ${report.recipes}, techniques ${report.techniques}, habits ${report.habits}, anchors ${report.anchors}`);
if (report.staleIngredients.length) console.warn(`  stale ingredients (in DB, not in /data): ${report.staleIngredients.join(", ")}`);
if (report.staleRecipes.length) console.warn(`  stale recipes (in DB, not in /data): ${report.staleRecipes.join(", ")}`);
