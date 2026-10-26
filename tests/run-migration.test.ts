import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import { requireMigrationPrefix } from "../lib/db/postgres/migration-ledger";
import { requireMigrationPrefix as previewReexport } from "../lib/deployment/preview-migration";
import { loadMigrationArtifacts, runGuardedMigration } from "../lib/deployment/run-migration";
import type { MigrationSession } from "../lib/deployment/run-migration";

const folder = path.resolve("db/postgres-migrations");
const artifacts = loadMigrationArtifacts(folder);
const session = (client: PGlite): MigrationSession => ({ query: (text) => client.query(text) as never });
const applyAll = (client: PGlite) => () => migrate(drizzle(client), { migrationsFolder: folder });

describe("shared migration ledger check", () => {
  const expected = [{ hash: "a", folderMillis: 1 }, { hash: "b", folderMillis: 2 }];
  it("accepts only an ordered prefix and is still exported for preview code", () => {
    expect(previewReexport).toBe(requireMigrationPrefix);
    expect(() => requireMigrationPrefix([], expected)).not.toThrow();
    expect(() => requireMigrationPrefix([{ hash: "a", created_at: 1 }], expected)).not.toThrow();
    expect(() => requireMigrationPrefix([{ hash: "a", created_at: 1 }], expected, true)).toThrow("pending or divergent");
    expect(() => requireMigrationPrefix([{ hash: "x", created_at: 1 }], expected)).toThrow("pending or divergent");
    expect(() => requireMigrationPrefix([{ hash: "a", created_at: 9 }], expected)).toThrow("pending or divergent");
  });
});

describe("guarded production migration", () => {
  it("applies on a fresh database, sets session limits and verifies ledger and schema", async () => {
    const client = new PGlite();
    try {
      const seen: string[] = [];
      const s = session(client);
      const spy: MigrationSession = { query: (t) => { seen.push(t); return s.query(t); } };
      const result = await runGuardedMigration({ session: spy, artifacts, apply: applyAll(client) });
      expect(result.applied).toBe(artifacts.expected.length);
      expect(seen.slice(0, 3)).toEqual(["set lock_timeout = '5s'", "set statement_timeout = '120s'", expect.stringContaining("pg_advisory_lock")]);
      // A second run is a no-op that still passes the full check.
      await runGuardedMigration({ session: s, artifacts, apply: applyAll(client) });
    } finally { await client.close(); }
  });

  it("refuses a divergent ledger before any write", async () => {
    const client = new PGlite();
    try {
      await client.exec(`create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
        insert into drizzle.__drizzle_migrations (hash, created_at) values ('unreviewed', 1);`);
      const apply = vi.fn();
      await expect(runGuardedMigration({ session: session(client), artifacts, apply })).rejects.toThrow("pending or divergent");
      expect(apply).not.toHaveBeenCalled();
      const tables = await client.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
      expect((tables.rows[0] as { n: number }).n).toBe(0);
    } finally { await client.close(); }
  });

  it("fails when the schema after migration does not match the reviewed snapshot", async () => {
    const client = new PGlite();
    try {
      const apply = async () => { await applyAll(client)(); await client.exec("create table stray_table (id int)"); };
      await expect(runGuardedMigration({ session: session(client), artifacts, apply })).rejects.toThrow("SCHEMA_DRIFT");
    } finally { await client.close(); }
  });

  it("fails when the ledger is not complete afterwards", async () => {
    const client = new PGlite();
    try {
      await expect(runGuardedMigration({ session: session(client), artifacts, apply: async () => {} })).rejects.toThrow("pending or divergent");
    } finally { await client.close(); }
  });

  it("serialises two runners on the advisory lock", async () => {
    // Minimal server model: one holder at a time, waiters queue in order.
    let holder: string | undefined;
    const waiters: (() => void)[] = [];
    const events: string[] = [];
    const fake = (name: string): MigrationSession => ({
      async query(text) {
        if (text.includes("pg_advisory_lock")) {
          while (holder) await new Promise<void>((resolve) => waiters.push(resolve));
          holder = name; events.push(`${name}:locked`);
        } else if (text.includes("pg_advisory_unlock")) {
          holder = undefined; events.push(`${name}:unlocked`); waiters.shift()?.();
        } else if (text.includes("to_regclass")) {
          return { rows: [{ name: null }] };
        } else if (text.includes("information_schema")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const empty = { expected: [], snapshots: [new Map()] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = runGuardedMigration({ session: fake("a"), artifacts: empty, apply: async () => { events.push("a:apply"); await gate; } });
    await new Promise((r) => setTimeout(r, 10));
    const b = runGuardedMigration({ session: fake("b"), artifacts: empty, apply: async () => { events.push("b:apply"); } });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["a:locked", "a:apply"]);
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:locked", "a:apply", "a:unlocked", "b:locked", "b:apply", "b:unlocked"]);
  });

  it("leaves a clean failure when the database cancels a statement: no ledger rows, lock released", async () => {
    // PGlite does not enforce statement_timeout; the native suite below exercises the real timeouts.
    const client = new PGlite();
    try {
      const apply = async () => { throw new Error("canceling statement due to statement timeout"); };
      await expect(runGuardedMigration({ session: session(client), artifacts, apply })).rejects.toThrow("statement timeout");
      const ledger = await client.query("select to_regclass('drizzle.__drizzle_migrations') as name");
      expect((ledger.rows[0] as { name: unknown }).name).toBeNull();
      const lock = await client.query("select pg_try_advisory_lock(197548, 1) as got");
      expect((lock.rows[0] as { got: boolean }).got).toBe(true);
    } finally { await client.close(); }
  });

  it("reports the original failure even when the unlock itself fails", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_advisory_unlock")) throw new Error("connection lost");
      return { rows: [] as Record<string, unknown>[] };
    });
    await expect(runGuardedMigration({
      session: { query }, artifacts: { expected: [], snapshots: [] },
      apply: async () => { throw new Error("DDL refused"); },
    })).rejects.toThrow("DDL refused");
  });

  it("rejects a malformed timeout before touching the session", async () => {
    const query = vi.fn();
    await expect(runGuardedMigration({
      session: { query }, artifacts, apply: vi.fn(), limits: { lockTimeout: "5s'; drop", statementTimeout: "1s" },
    })).rejects.toThrow("Invalid migration timeout");
    expect(query).not.toHaveBeenCalled();
  });
});
