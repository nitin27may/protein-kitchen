import path from "node:path";
import { loadData } from "@/lib/data/load";
import type { DataSet } from "@/lib/data/load";
import { openDb } from "@/lib/db/client";
import type { Db, DbHandle } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/seed";

interface Ctx {
  data: DataSet;
  handle: DbHandle;
  /** Resolves once the content tables match /data. Memoised; cleared on failure so the next call retries. */
  ready?: Promise<void>;
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
  g.__pkCtx = { data, handle };
  return g.__pkCtx;
}

/** Seeds the database from /data when its recipe or ingredient counts differ. The seed is async, so every database accessor awaits this. */
function ready(c: Ctx): Promise<void> {
  if (!c.ready) {
    c.ready = (async () => {
      const count = c.handle.sqlite.prepare("SELECT count(*) AS n FROM recipes").get() as { n: number };
      const ingCount = c.handle.sqlite.prepare("SELECT count(*) AS n FROM ingredients").get() as { n: number };
      if (count.n !== c.data.recipes.size || ingCount.n !== c.data.ingredients.size) await seedDatabase(c.handle.db, c.data);
    })().catch((e) => {
      c.ready = undefined;
      throw e;
    });
  }
  return c.ready;
}

/** Content from /data. Synchronous: it only reads files already loaded. */
export const getData = () => ctx().data;

/** The database. Async because the first call waits for the content seed. Same drizzle instance as before. */
export async function getDb(): Promise<Db> {
  const c = ctx();
  await ready(c);
  return c.handle.db;
}

export async function getSqlite() {
  const c = ctx();
  await ready(c);
  return c.handle.sqlite;
}
