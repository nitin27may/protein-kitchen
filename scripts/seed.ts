import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "../lib/data/load";
import { openDb } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.DB_PATH ?? path.join(root, "db", "app.db");

const data = loadData(root);
if (data.issues.length) {
  for (const i of data.issues) console.error(`${i.file}: ${i.message}`);
  process.exit(1);
}

const { sqlite, db } = openDb(file, path.join(root, "db", "migrations"));
const report = await seedDatabase(db, data);
sqlite.close();

console.log(`Seeded ${file}`);
console.log(`  ingredients ${report.ingredients}, recipes+components ${report.recipes}, techniques ${report.techniques}, habits ${report.habits}, anchors ${report.anchors}`);
if (report.staleIngredients.length) console.warn(`  stale ingredients (in DB, not in /data): ${report.staleIngredients.join(", ")}`);
if (report.staleRecipes.length) console.warn(`  stale recipes (in DB, not in /data): ${report.staleRecipes.join(", ")}`);
