import { loadData } from "@/lib/data/load";
import type { DataSet } from "@/lib/data/load";
import { openDb } from "@/lib/db/client";
import type { Db, DbHandle } from "@/lib/db/client";
import { verifyLibraryVersion } from "@/lib/db/library-version";

interface Ctx {
  data: DataSet;
  handle?: DbHandle;
  /** Read-only version check, memoised; cleared on failure so the next call retries. */
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
  g.__pkCtx = { data };
  return g.__pkCtx;
}

/** Requests never migrate or seed; release tooling must prepare the exact library version. */
function ready(c: Ctx): Promise<void> {
  if (!c.ready) {
    c.ready = (async () => {
      const handle = c.handle ??= await openDb();
      await verifyLibraryVersion(handle.db, c.data);
    })().catch((e) => {
      c.ready = undefined;
      throw e;
    });
  }
  return c.ready;
}

/** Content from /data. Synchronous: it only reads files already loaded. */
export const getData = () => ctx().data;

/** Reuses one guarded pool and verifies the library version before serving database-backed requests. */
export async function getDb(): Promise<Db> {
  const c = ctx();
  await ready(c);
  return c.handle!.db;
}
