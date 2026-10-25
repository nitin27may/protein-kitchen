import fs from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestRows, importColumns, importTables, normalizeImportValue, readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";
import * as s from "../lib/db/schema";
import { openDb } from "./helpers/db";
import { createSqliteSource } from "./helpers/sqlite-source";
import { sqliteImportTarget } from "../lib/db/postgres/import-target";

let source: ReturnType<typeof createSqliteSource>;
beforeEach(() => { source = createSqliteSource(); });
afterEach(() => { source.close(); });

describe("read-only SQLite snapshot", () => {
  it("captures every legacy table without changing the source file", () => {
    const before = fs.readFileSync(source.file);
    const modified = fs.statSync(source.file).mtimeMs;
    const snapshot = readSqliteSnapshot(source.file);
    expect(Object.keys(snapshot.tables)).toHaveLength(33);
    expect(Object.values(snapshot.tables).every((d) => d.count === 1)).toBe(true);
    expect(snapshot.rows.people).toMatchObject([{ id: 300, birth_date: "2000-02-29", diet_flags: ["vegetarian"] }]);
    expect(snapshot.rows.recipe_feedback).toMatchObject([{ uid: "feedback-fixture", rating: 4, favourite: true, tested_at: "2026-10-23T12:00:00.000Z" }]);
    expect(snapshot.rows.sync_state).toMatchObject([{ exported_at: "2026-10-23T00:00:00.000Z" }]);
    expect(Object.keys(snapshot.rows.sync_state![0]!).sort()).toEqual(["changed_at", "data_class", "exported_at"]);
    expect(fs.readFileSync(source.file)).toEqual(before);
    expect(fs.statSync(source.file).mtimeMs).toBe(modified);
  });

  it("has deterministic digests independent of row and JSON key order", () => {
    expect(digestRows([{ x: 1, y: { b: 2, a: 1 } }, { x: 2 }])).toEqual(digestRows([{ x: 2 }, { y: { a: 1, b: 2 }, x: 1 }]));
    expect(digestRows([{ x: 1 }])).not.toEqual(digestRows([{ x: 2 }]));
  });

  it("allows local dev/test but refuses production and remote targets without the additional branch pin", () => {
    expect(sqliteImportTarget({ DATABASE_ENV: "test", DATABASE_URL_UNPOOLED: "postgres://fixture@127.0.0.1/protein_kitchen_test" }).databaseEnvironment).toBe("test");
    expect(() => sqliteImportTarget({ DATABASE_ENV: "production", DATABASE_URL_UNPOOLED: "postgres://fixture@127.0.0.1/protein_kitchen_test" })).toThrow();
    expect(() => sqliteImportTarget({ DATABASE_ENV: "test", DATABASE_URL: "postgres://fixture@127.0.0.1/protein_kitchen_test" })).toThrow();
    expect(() => sqliteImportTarget({
      DATABASE_ENV: "development", DATABASE_URL_UNPOOLED: "postgres://fixture@ep-production.neon.tech/neondb?sslmode=verify-full",
      DATABASE_NONPRODUCTION_HOST: "ep-production.neon.tech",
    })).toThrow("loopback");
  });

  it("allows remote rehearsal configuration only with a matching explicit development branch pin", () => {
    const env = {
      DATABASE_ENV: "development",
      DATABASE_URL_UNPOOLED: "postgres://fixture@ep-development.neon.tech/neondb?sslmode=verify-full",
      DATABASE_NONPRODUCTION_HOST: "ep-development.neon.tech", NEON_DEVELOPMENT_BRANCH_ID: "br-development",
      SQLITE_IMPORT_NEON_BRANCH_ID: "br-development",
    };
    expect(sqliteImportTarget(env).nonProductionHost).toBe("ep-development.neon.tech");
    expect(() => sqliteImportTarget({ ...env, SQLITE_IMPORT_NEON_BRANCH_ID: "br-other" })).toThrow("explicitly match");
  });

  it("refuses an absent source instead of creating a new SQLite file", () => {
    const file = `${source.file}.missing`;
    expect(() => readSqliteSnapshot(file)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses unknown source tables instead of silently losing their rows", () => {
    source.sqlite.exec("CREATE TABLE unsupported (id integer)");
    expect(() => readSqliteSnapshot(source.file)).toThrow("source tables");
  });

  it("refuses unsupported source columns", () => {
    source.sqlite.exec("ALTER TABLE recipes ADD COLUMN unsupported text");
    expect(() => readSqliteSnapshot(source.file)).toThrow("source columns");
  });

  it("does not accept new Postgres-only revision columns in the frozen SQLite source", () => {
    source.sqlite.exec("ALTER TABLE sync_state ADD COLUMN revision integer NOT NULL DEFAULT 1");
    expect(() => readSqliteSnapshot(source.file)).toThrow("source columns do not match sync_state");
  });

  it("refuses a target table without a legacy import column contract", () => {
    expect(() => importColumns(s.authUsers)).toThrow("no legacy column contract");
  });

  it("refuses broken source foreign keys", () => {
    source.sqlite.pragma("foreign_keys = OFF");
    source.sqlite.exec("UPDATE plan_slot_portions SET person_id = 9999");
    expect(() => readSqliteSnapshot(source.file)).toThrow("broken foreign keys");
  });

  it.each([
    [s.ingredients.isDairy, 2], [s.ingredients.proteinG, "10"], [s.ingredients.kcal, Infinity],
    [s.people.id, 1.5], [s.people.id, 2147483648], [s.people.name, null], [s.people.name, "bad\0text"],
    [s.planSetups.personIds, "not JSON"], [s.people.birthDate, "2026-02-30"],
    [s.plans.createdAt, "2026-10-23T12:00:00"], [s.plans.createdAt, "nonsense"],
    [s.plans.createdAt, "2026-02-30T12:00:00Z"], [s.plans.createdAt, "2026-10-23T24:00:00Z"],
    [s.planSetups.personIds, "[9007199254740993]"], [s.planSetups.personIds, "[1e999]"], [s.planSetups.personIds, "null"],
  ])("rejects unrepresentable values without printing row contents (%#)", (column, value) => {
    expect(() => normalizeImportValue(column, value)).toThrow("cannot normalize");
  });
});

describe("atomic SQLite restore", () => {
  it("preserves ids, relationships and metadata; verifies counts/checksums and restarts every identity", async () => {
    const target = await openDb();
    const snapshot = readSqliteSnapshot(source.file);
    expect(await restoreSqliteSnapshot(target.db, snapshot)).toEqual(snapshot.tables);
    expect(await target.db.select().from(s.syncState)).toEqual([{
      dataClass: "recipe-feedback", changedAt: "2026-10-23T12:00:00.000Z", exportedAt: "2026-10-23T00:00:00.000Z",
      revision: 1, exportedRevision: 0, householdId: "00000000-0000-4000-8000-000000000001",
    }]);
    expect(await target.db.select().from(s.libraryState)).toEqual([]);
    for (const table of importTables) {
      const columns = getTableColumns(table);
      const id = Object.values(columns).find((c) => c.generatedIdentity);
      if (!id) continue;
      const name = getTableName(table);
      const next = await target.client.query<{ n: number }>(`SELECT nextval(pg_get_serial_sequence('${name}', '${id.name}'))::integer as n`);
      const old = Math.max(...snapshot.rows[name]!.map((r) => Number(r[id.name])));
      expect(next.rows[0]!.n, name).toBe(old + 1);
    }
  });

  it("rehearses twice into independent empty destinations with identical verified bytes", async () => {
    const snapshot = readSqliteSnapshot(source.file);
    const a = await openDb();
    const b = await openDb();
    expect(await restoreSqliteSnapshot(a.db, snapshot)).toEqual(await restoreSqliteSnapshot(b.db, snapshot));
  });

  it("refuses a second import into a populated destination without changing existing rows", async () => {
    const target = await openDb();
    const snapshot = readSqliteSnapshot(source.file);
    await restoreSqliteSnapshot(target.db, snapshot);
    await expect(restoreSqliteSnapshot(target.db, snapshot)).rejects.toThrow("empty destination");
    expect(await target.db.select().from(s.photos)).toHaveLength(1);
    expect(await target.db.select().from(s.recipeFeedback)).toMatchObject([{ notes: "Synthetic human note", uid: "feedback-fixture" }]);
  });

  it("refuses a seeded/versioned destination even when legacy tables are empty", async () => {
    const target = await openDb();
    await target.db.insert(s.libraryState).values({ key: "library", version: "existing" });
    await expect(restoreSqliteSnapshot(target.db, readSqliteSnapshot(source.file))).rejects.toThrow("library_state");
    expect(await target.db.select().from(s.people)).toEqual([]);
  });

  it("refuses a destination containing identity data even when every legacy table is empty", async () => {
    const target = await openDb();
    await target.db.insert(s.authUsers).values({ id: "existing-account", name: "Synthetic account", email: "existing@example.test" });
    await expect(restoreSqliteSnapshot(target.db, readSqliteSnapshot(source.file))).rejects.toThrow("auth_users");
    expect(await target.db.select().from(s.authUsers)).toMatchObject([{ id: "existing-account" }]);
    expect(await target.db.select().from(s.people)).toEqual([]);
  });

  it("rolls back every table on an interrupted insert, then succeeds on retry", async () => {
    const target = await openDb();
    const snapshot = readSqliteSnapshot(source.file);
    await target.failWrite("plan_slot_portions", "insert", "fail_import");
    await expect(restoreSqliteSnapshot(target.db, snapshot)).rejects.toThrow();
    for (const table of importTables) expect(await target.db.select().from(table), getTableName(table)).toEqual([]);
    await target.dropFailure("plan_slot_portions", "fail_import");
    expect(await restoreSqliteSnapshot(target.db, snapshot)).toEqual(snapshot.tables);
  });

  it("rolls back if destination readback differs, not merely when a constraint rejects a write", async () => {
    const target = await openDb();
    await target.client.exec(`CREATE FUNCTION corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.notes = 'unexpected transformation'; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_import BEFORE INSERT ON recipe_feedback FOR EACH ROW EXECUTE FUNCTION corrupt_import();`);
    await expect(restoreSqliteSnapshot(target.db, readSqliteSnapshot(source.file))).rejects.toThrow("verification failed for recipe_feedback");
    expect(await target.db.select().from(s.people)).toEqual([]);
    expect(await target.db.select().from(s.recipeFeedback)).toEqual([]);
  });

  it("rejects an incomplete or modified snapshot before writing anything", async () => {
    const target = await openDb();
    const snapshot = readSqliteSnapshot(source.file);
    snapshot.rows.people![0]!.name = "Changed";
    await expect(restoreSqliteSnapshot(target.db, snapshot)).rejects.toThrow("checksum mismatch for people");
    delete snapshot.rows.people;
    await expect(restoreSqliteSnapshot(target.db, snapshot)).rejects.toThrow("exactly the supported");
    expect(await target.db.select().from(s.recipes)).toEqual([]);
  });

  it("rejects an entirely empty source rather than claiming a meaningless successful import", async () => {
    source.sqlite.pragma("foreign_keys = OFF");
    for (const table of importTables) source.sqlite.exec(`DELETE FROM "${getTableName(table)}"`);
    const target = await openDb();
    await expect(restoreSqliteSnapshot(target.db, readSqliteSnapshot(source.file))).rejects.toThrow("no application rows");
    expect(await target.db.select().from(s.libraryState)).toEqual([]);
  });

  it("rolls back identity restarts as well as rows if a later sequence cannot be repaired", async () => {
    source.sqlite.exec("UPDATE photo_decisions SET id = 2147483647");
    const target = await openDb();
    await expect(restoreSqliteSnapshot(target.db, readSqliteSnapshot(source.file))).rejects.toThrow("Identity range exhausted");
    expect(await target.db.select().from(s.ingredients)).toEqual([]);
    const next = await target.client.query<{ n: number }>("SELECT nextval('ingredients_id_seq')::integer AS n");
    expect(next.rows[0]!.n).toBe(1);
    source.sqlite.exec("UPDATE photo_decisions SET id = 660");
    const snapshot = readSqliteSnapshot(source.file);
    expect(await restoreSqliteSnapshot(target.db, snapshot)).toEqual(snapshot.tables);
  });
});
