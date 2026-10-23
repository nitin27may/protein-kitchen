import path from "node:path";
import { loadData } from "@/lib/data/load";
import type { DataSet } from "@/lib/data/load";
import { openDb } from "@/lib/db/client";
import type { DbHandle } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/seed";

interface Ctx {
  data: DataSet;
  handle: DbHandle;
}

const g = globalThis as unknown as { __pkCtx?: Ctx };

const root = process.cwd();

/** Content files are read once per server process. The database holds ids and all user state. */
export function ctx(): Ctx {
  if (g.__pkCtx) return g.__pkCtx;
  const data = loadData(root);
  if (data.issues.length) {
    throw new Error(`Data files are invalid: ${data.issues.map((i) => `${i.file}: ${i.message}`).join("; ")}`);
  }
  const file = process.env.DB_PATH ?? path.join(root, "db", "app.db");
  const handle = openDb(file, path.join(root, "db", "migrations"));
  const count = handle.sqlite.prepare("SELECT count(*) AS n FROM recipes").get() as { n: number };
  const ingCount = handle.sqlite.prepare("SELECT count(*) AS n FROM ingredients").get() as { n: number };
  if (count.n !== data.recipes.size || ingCount.n !== data.ingredients.size) seedDatabase(handle.db, data);
  g.__pkCtx = { data, handle };
  return g.__pkCtx;
}

export const getData = () => ctx().data;
export const getDb = () => ctx().handle.db;
export const getSqlite = () => ctx().handle.sqlite;
