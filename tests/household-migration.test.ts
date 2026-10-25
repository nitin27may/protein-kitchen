import path from "node:path";
import os from "node:os";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../lib/db/schema";
import { digestRows, importColumns, importTables, readSqliteSnapshot, type SqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { createSqliteSource } from "./helpers/sqlite-source";
import { withTx } from "../lib/db/tx";
import type { Db } from "../lib/db/client";

const legacyId = "00000000-0000-4000-8000-000000000001";
const folder = path.resolve("db/postgres-migrations");
const ownershipTables = [
  schema.householdInvitations, schema.householdMembers, schema.pantry, schema.people, schema.photoDecisions,
  schema.photos, schema.planSetups, schema.plans, schema.prepTaskState, schema.recipeFeedback, schema.recipeLinks,
  schema.savedViews, schema.stateSyncJobs, schema.syncState,
];

/** Run the real previous journal, then upgrade with the real current journal. */
async function beforeHouseholdMigration(run: (db: Db, upgrade: () => Promise<void>) => Promise<void>, beforeIndex = 10) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pk-household-migration-"));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    cpSync(folder, directory, { recursive: true });
    const journalFile = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx < beforeIndex);
    writeFileSync(journalFile, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: directory });
    await run(db, () => migrate(db, { migrationsFolder: folder }));
  } finally {
    await client.close();
    rmSync(directory, { recursive: true });
  }
}

async function insertLegacy(db: Db, snapshot: SqliteSnapshot) {
  const pending = [...importTables];
  const done = new Set<string>();
  while (pending.length) {
    const at = pending.findIndex((table) => getTableConfig(table).foreignKeys.every((fk) => {
      const reference = fk.reference();
      return !reference.columns.some((column) => importColumns(table).includes(column)) ||
        reference.foreignTable === table || done.has(getTableName(reference.foreignTable));
    }));
    if (at < 0) throw new Error("Legacy migration fixture has cyclic dependencies.");
    const table = pending.splice(at, 1)[0]!;
    const name = getTableName(table);
    const columns = importColumns(table);
    for (const row of snapshot.rows[name]!) {
      await db.execute(sql`insert into ${table} (${sql.join(columns.map((c) => sql.identifier(c.name)), sql`, `)})
        values (${sql.join(columns.map((c) => row[c.name] === null ? sql`null` : sql`${c.mapToDriverValue(row[c.name])}`), sql`, `)})`);
    }
    done.add(name);
  }
}

describe("household ownership expansion migration", () => {
  it("rolls back all cross-parent DDL on inconsistent owned rows and permits an explicit repair then retry", async () => {
    await beforeHouseholdMigration(async (db, upgrade) => {
      await db.insert(schema.households).values([{ id: "a", name: "First fixture" }, { id: "b", name: "Second fixture" }]);
      const [person] = await db.insert(schema.people).values({
        householdId: "a", name: "Synthetic profile", sex: "other", birthDate: "2000-01-01",
        heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
      }).returning({ id: schema.people.id });
      await db.insert(schema.authUsers).values({ id: "fixture", name: "Fixture", email: "fixture@example.test", emailVerified: true });
      await db.insert(schema.householdMembers).values({ householdId: "b", userId: "fixture", personId: person!.id, role: "owner" });
      await db.execute(sql`insert into household_invitations
        (household_id, id, email, token_hash, invited_by_user_id, person_id, created_at, expires_at)
        values ('b', 'fixture', 'future@example.test', 'fixture', 'fixture', ${person!.id},
          '2026-11-01T12:00:00.000Z', '2026-11-08T12:00:00.000Z')`);
      const [setup] = await db.insert(schema.planSetups).values({
        householdId: "a", personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, createdAt: "2026-11-01T12:00:00.000Z",
      }).returning({ id: schema.planSetups.id });
      await db.insert(schema.plans).values({ householdId: "b", setupId: setup!.id, seed: 42, createdAt: "2026-11-01T12:00:00.000Z" });
      const original = await db.select().from(schema.people);
      for (const table of [schema.householdInvitations, schema.householdMembers, schema.plans]) {
        await expect(upgrade()).rejects.toThrow();
        const index = await db.execute(sql`select to_regclass('public.people_household_id_uq') as name`);
        expect(index).toMatchObject({ rows: [{ name: null }] });
        expect(await db.select().from(schema.people)).toEqual(original);
        await db.update(table).set({ householdId: "a" });
      }
      await upgrade();
      await upgrade();
      expect(await db.select().from(schema.people)).toEqual(original);
      await expect(db.update(schema.householdMembers).set({ householdId: "b" })).rejects.toThrow();
      await expect(db.update(schema.householdInvitations).set({ householdId: "b" })).rejects.toThrow();
      await expect(db.update(schema.plans).set({ householdId: "b" })).rejects.toThrow();
    }, 11);
  });

  it("leaves fresh empty targets empty for guarded source imports and is journal-idempotent", async () => {
    await beforeHouseholdMigration(async (db, upgrade) => {
      await upgrade();
      expect(await db.select().from(schema.households)).toEqual([]);
      await upgrade();
      expect(await db.select().from(schema.households)).toEqual([]);
    });
  });

  it("backfills every legacy ownership root into exactly one household without changing any frozen source bytes", async () => {
    const source = createSqliteSource();
    try {
      const snapshot = readSqliteSnapshot(source.file);
      await beforeHouseholdMigration(async (db, upgrade) => {
        await insertLegacy(db, snapshot);
        await db.insert(schema.authUsers).values({ id: "legacy-owner", name: "Synthetic owner", email: "legacy@example.test", emailVerified: true });
        await db.execute(sql`insert into household_members (user_id, role, person_id) values ('legacy-owner', 'owner', 300)`);
        await db.execute(sql`insert into household_invitations
          (id, email, token_hash, invited_by_user_id, person_id, expires_at)
          values ('legacy-invitation', 'future@example.test', 'synthetic-hash', 'legacy-owner', null, now() + interval '7 days')`);
        await db.execute(sql`insert into state_sync_jobs (target_key) values ('legacy-target')`);
        await upgrade();
        const households = await db.select().from(schema.households);
        expect(households).toMatchObject([{ id: legacyId, name: "Existing household" }]);
        for (const table of ownershipTables) {
          const rows = await db.select({ householdId: table.householdId }).from(table);
          expect(rows.length, getTableName(table)).toBeGreaterThan(0);
          expect(rows.every((row) => row.householdId === legacyId), getTableName(table)).toBe(true);
        }
        for (const table of importTables) {
          const rows = await db.select(Object.fromEntries(importColumns(table).map((c) => [c.name, c]))).from(table);
          expect(digestRows(rows), getTableName(table)).toEqual(snapshot.tables[getTableName(table)]);
        }
        expect(await db.select().from(schema.householdMembers)).toMatchObject([{ userId: "legacy-owner", personId: 300, role: "owner", householdId: legacyId }]);
        await upgrade();
        expect(await db.select().from(schema.households)).toEqual(households);
        await expect(withTx(db, (tx) => tx.delete(schema.households).where(sql`${schema.households.id} = ${legacyId}`))).rejects.toThrow();
        await expect(withTx(db, (tx) => tx.update(schema.people).set({ householdId: "missing-household" }))).rejects.toThrow();
        expect(await db.select({ householdId: schema.people.householdId }).from(schema.people)).toEqual([{ householdId: legacyId }]);
      });
    } finally { source.close(); }
  });

  it("does not create household access from identity-only accounts or seed-only library content", async () => {
    await beforeHouseholdMigration(async (db, upgrade) => {
      await db.insert(schema.authUsers).values({ id: "identity-only", name: "Synthetic account", email: "identity@example.test", emailVerified: true });
      await db.insert(schema.libraryState).values({ key: "library", version: "synthetic" });
      await upgrade();
      expect(await db.select().from(schema.households)).toEqual([]);
      expect(await db.select().from(schema.householdMembers)).toEqual([]);
    });
  });

  it("rolls the entire schema expansion and backfill back when a legacy update fails", async () => {
    await beforeHouseholdMigration(async (db, upgrade) => {
      await db.execute(sql`insert into people (id, name, sex, birth_date, height_cm, weight_kg, activity_level, diet_flags)
        values (1, 'Synthetic legacy cook', 'other', '2000-01-01', 170, 70, 'light', '[]')`);
      await db.execute(sql`create function reject_household_backfill() returns trigger language plpgsql as
        $$ begin raise exception 'injected ownership failure'; end $$`);
      await db.execute(sql`create trigger reject_household_backfill before update on people
        for each row execute function reject_household_backfill()`);
      await expect(upgrade()).rejects.toThrow();
      const result = await db.select({ name: sql<string>`table_name` }).from(sql`information_schema.tables`)
        .where(sql`table_schema = 'public' and table_name = 'households'`);
      expect(result).toEqual([]);
      expect(await db.select({ name: schema.people.name }).from(schema.people)).toEqual([{ name: "Synthetic legacy cook" }]);
      await db.execute(sql`drop trigger reject_household_backfill on people`);
      await db.execute(sql`drop function reject_household_backfill()`);
      await upgrade();
      expect(await db.select().from(schema.people)).toMatchObject([{ id: 1, householdId: legacyId }]);
    });
  });
});
