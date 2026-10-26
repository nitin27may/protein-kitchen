import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMigrationArtifacts, runGuardedMigration } from "../lib/deployment/run-migration";
import type { MigrationSession } from "../lib/deployment/run-migration";

const url = process.env.POSTGRES_TEST_URL;
const empty = { expected: [], snapshots: [] };
const artifacts = loadMigrationArtifacts("db/postgres-migrations");
let pool: Pool;

/** Real lock and timeout behaviour needs a real server (PGlite is single-session and ignores statement_timeout). */
describe.skipIf(!url)("guarded migration on disposable native Postgres", () => {
  beforeAll(() => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.pathname !== "/protein_kitchen_test") {
      throw new Error("Integration tests require a loopback-only protein_kitchen_test database.");
    }
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => { await pool?.end(); });

  const session = async () => {
    const client = await pool.connect();
    const wrapped: MigrationSession = { query: (text) => client.query(text) };
    return { wrapped, client };
  };

  it("makes a second runner fail on lock_timeout without applying while the first holds the lock", async () => {
    const holder = await pool.connect();
    await holder.query("select pg_advisory_lock(197548, 1)");
    const second = await session();
    const apply = vi.fn();
    try {
      await expect(runGuardedMigration({
        session: second.wrapped, artifacts: empty, apply, limits: { lockTimeout: "200ms", statementTimeout: "5s" },
      })).rejects.toThrow(/lock timeout/i);
      expect(apply).not.toHaveBeenCalled();
    } finally { second.client.release(true); }
    holder.release(true);
  });

  it("cancels a statement past statement_timeout and releases the lock", async () => {
    const one = await session();
    try {
      await expect(runGuardedMigration({
        session: one.wrapped, artifacts, limits: { lockTimeout: "1s", statementTimeout: "200ms" },
        apply: async () => { await one.client.query("select pg_sleep(3)"); },
      })).rejects.toThrow(/statement timeout/i);
      const free = await pool.query("select pg_try_advisory_lock(197548, 2) as got");
      expect(free.rows[0].got).toBe(true);
    } finally { one.client.release(true); }
  });
});
