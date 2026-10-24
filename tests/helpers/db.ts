import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, expect } from "vitest";
import type { Db } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";

export interface DbHandle {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
  failWrite(table: string, operation: string, name: string, when?: string): Promise<void>;
  dropFailure(table: string, name: string): Promise<void>;
}

const handles = new Map<DbHandle, string | undefined>();
afterEach(async () => {
  for (const [handle, test] of handles) if (test === expect.getState().currentTestName) await handle.close();
});
afterAll(async () => {
  for (const handle of handles.keys()) await handle.close();
});

/** A disposable Postgres engine, never an environment-selected database. */
export async function openDb(): Promise<DbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve("db/postgres-migrations") });
  let closed = false;
  const identifier = (value: string) => {
    if (!/^[a-z_]+$/i.test(value)) throw new Error("Invalid fixture SQL identifier.");
    return `"${value}"`;
  };
  const handle: DbHandle = {
    db, client,
    async close() {
      if (!closed) { closed = true; await client.close(); handles.delete(handle); }
    },
    async failWrite(table, operation, name, when) {
      if (!["INSERT", "UPDATE", "DELETE"].includes(operation.toUpperCase())) throw new Error("Invalid fixture operation.");
      await client.exec(`CREATE FUNCTION ${identifier(name)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected persistence failure'; END $$;
        CREATE TRIGGER ${identifier(name)} BEFORE ${operation} ON ${identifier(table)}
        FOR EACH ROW ${when ? `WHEN (${when})` : ""} EXECUTE FUNCTION ${identifier(name)}();`);
    },
    async dropFailure(table, name) {
      await client.exec(`DROP TRIGGER ${identifier(name)} ON ${identifier(table)}; DROP FUNCTION ${identifier(name)}();`);
    },
  };
  handles.set(handle, expect.getState().currentTestName);
  return handle;
}
