import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import * as pg from "../lib/db/postgres/schema";
import * as sqlite from "../lib/db/sqlite-schema";

type PostgresRows = { [K in keyof typeof sqlite]: K extends "syncState"
  ? Omit<(typeof pg)[K]["$inferSelect"], "revision" | "exportedRevision">
  : K extends "people" ? Omit<(typeof pg)[K]["$inferSelect"], "reminderTimezone"> : (typeof pg)[K]["$inferSelect"] };
type SQLiteRows = { [K in keyof typeof sqlite]: (typeof sqlite)[K]["$inferSelect"] };

describe("Postgres baseline parity", () => {
  it("preserves every application row type", () => {
    expectTypeOf<PostgresRows>().toEqualTypeOf<SQLiteRows>();
  });

  it("preserves all tables, columns, nullability, keys, indexes and foreign-key deletion behavior", () => {
    const postgresOnly = ["libraryState", "authUsers", "authSessions", "authAccounts", "authVerifications", "authRateLimits",
      "householdBootstrap", "householdMembers", "householdInvitations", "personRecipeFeedback", "stateSyncJobs", "stateSyncRequests",
      "reminderBatches", "reminderDeliveries"];
    expect(Object.keys(pg).filter((key) => !postgresOnly.includes(key)).sort()).toEqual(Object.keys(sqlite).sort());
    for (const name of Object.keys(sqlite) as (keyof typeof sqlite)[]) {
      const source = sqliteConfig(sqlite[name]);
      const target = pgConfig(pg[name]);
      expect(target.name, name).toBe(source.name);
      const columns = (config: typeof source | typeof target) => config.columns.map((c) => ({
        name: c.name, notNull: c.notNull, primary: c.primary, unique: c.isUnique,
        enum: c.enumValues, default: c.default,
      })).sort((a, b) => a.name.localeCompare(b.name));
      expect(columns(target).filter((c) => (name !== "syncState" || !["revision", "exported_revision"].includes(c.name)) &&
        (name !== "people" || c.name !== "reminder_timezone")), name).toEqual(columns(source));
      if (name === "people") {
        expect(columns(target).find((c) => c.name === "reminder_timezone")).toMatchObject({ notNull: false, default: undefined });
      }
      if (name === "syncState") {
        expect(columns(target).filter((c) => ["revision", "exported_revision"].includes(c.name))).toEqual([
          { name: "exported_revision", notNull: true, primary: false, unique: false, enum: undefined, default: 0 },
          { name: "revision", notNull: true, primary: false, unique: false, enum: undefined, default: 1 },
        ]);
      }
      expect(target.primaryKeys.map((key) => key.columns.map((c) => c.name)), name)
        .toEqual(source.primaryKeys.map((key) => key.columns.map((c) => c.name)));
      const foreignKeys = (config: typeof source | typeof target) => config.foreignKeys.map((key) => {
        const ref = key.reference();
        return {
          columns: ref.columns.map((c) => c.name), table: getTableName(ref.foreignTable),
          foreign: ref.foreignColumns.map((c) => c.name), onDelete: key.onDelete ?? "no action",
        };
      }).sort((a, b) => a.columns.join().localeCompare(b.columns.join()));
      expect(foreignKeys(target), name).toEqual(foreignKeys(source));
      const indexes = (config: typeof source | typeof target) => config.indexes.map((index) => ({
        name: index.config.name, unique: index.config.unique,
        columns: index.config.columns.map((c) => "name" in c ? c.name : undefined),
      })).sort((a, b) => a.name!.localeCompare(b.name!));
      expect(indexes(target), name).toEqual(indexes(source));
      const uniqueConstraints = (config: typeof source | typeof target) => config.uniqueConstraints.map((key) => ({
        columns: key.columns.map((c) => c.name),
      }));
      expect(uniqueConstraints(target), name).toEqual(uniqueConstraints(source));
      expect(target.checks.map((c) => c.name).sort(), name).toEqual(name === "syncState" ? ["sync_state_revision_valid"] : source.checks.map((c) => c.name).sort());
    }
  });
});

const client = new PGlite();
const db = drizzle(client, { schema: pg });
const migrationsFolder = path.resolve(__dirname, "..", "db", "postgres-migrations");
const now = "2026-10-23T12:34:56.789Z";

beforeAll(async () => {
  await migrate(db, { migrationsFolder });
}, 30_000);

afterEach(async () => {
  await db.execute(sql`truncate table ${sql.join(Object.values(pg).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});

afterAll(async () => { await client.close(); });

describe("Postgres migration on PGlite", () => {
  it("adds timezone without changing an existing profile or its legacy reminder claim", async () => {
    const old = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      for (const migration of migrations.slice(0, 8)) for (const statement of migration.sql) await old.exec(statement);
      await old.query("insert into people(id, name, sex, birth_date, height_cm, weight_kg, activity_level, diet_flags, reminder_time) values (1, 'Synthetic cook', 'other', '2000-01-01', 170, 70, 'light', '[]', '21:00')");
      await old.query("insert into reminder_log(date, person_id, sent_at) values ('2026-10-24', 1, $1)", [now]);
      const before = (await old.query<Record<string, unknown>>("select * from people")).rows[0];
      const claims = (await old.query("select * from reminder_log")).rows;
      for (const migration of migrations.slice(8)) for (const statement of migration.sql) await old.exec(statement);
      expect((await old.query("select * from people")).rows).toEqual([{ ...before, reminder_timezone: null }]);
      expect((await old.query("select * from reminder_log")).rows).toEqual(claims);
    } finally { await old.close(); }
  });
  it("upgrades existing bootstrap provenance without reopening admission or changing its timestamp", async () => {
    const old = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      for (const migration of migrations.slice(0, 5)) for (const statement of migration.sql) await old.exec(statement);
      await old.query("insert into auth_users(id, name, email, email_verified) values ($1, $2, $3, true)", ["original", "Synthetic creator", "original@example.test"]);
      await old.query("insert into household_bootstrap(id, owner_user_id, created_at) values (1, $1, $2)", ["original", now]);
      await expect(old.query("delete from auth_users where id = $1", ["original"])).rejects.toThrow();
      for (const migration of migrations.slice(5)) for (const statement of migration.sql) await old.exec(statement);
      const before = await old.query<{ id: number; owner_user_id: string | null; created_at: Date }>("select * from household_bootstrap");
      expect(before.rows).toMatchObject([{ id: 1, owner_user_id: "original", created_at: new Date(now) }]);
      await old.query("delete from auth_users where id = $1", ["original"]);
      expect((await old.query("select * from household_bootstrap")).rows).toEqual([{ ...before.rows[0], owner_user_id: null }]);
    } finally { await old.close(); }
  });

  it("creates every table and can be applied twice without replaying the baseline", async () => {
    await migrate(db, { migrationsFolder });
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    expect(result.rows.map((r) => r.table_name).sort()).toEqual(Object.values(pg).map(getTableName).sort());
    const journal = await client.query("select * from drizzle.__drizzle_migrations");
    expect(journal.rows).toHaveLength(10);
  });

  it("upgrades existing sync timestamps without treating a local export as remote acknowledgement", async () => {
    const old = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      for (const migration of migrations.slice(0, 6)) for (const statement of migration.sql) await old.exec(statement);
      await old.query("insert into sync_state(data_class, changed_at, exported_at) values ($1, $2, $2)", ["saved-views", now]);
      for (const migration of migrations.slice(6)) for (const statement of migration.sql) await old.exec(statement);
      expect((await old.query("select * from sync_state")).rows).toEqual([
        { data_class: "saved-views", changed_at: new Date(now), exported_at: new Date(now), revision: 1, exported_revision: 0 },
      ]);
      for (const [revision, exported] of [[0, 0], [1, -1], [1, 2]]) {
        await expect(old.query("update sync_state set revision = $1, exported_revision = $2", [revision, exported])).rejects.toThrow();
      }
    } finally { await old.close(); }
  });

  it("round-trips JSON, booleans, dates, UTC timestamps, generated ids and double precision", async () => {
    const [person] = await db.insert(pg.people).values({
      name: "Postgres fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170.123456789,
      weightKg: 70, activityLevel: "light", dietFlags: ["vegetarian"],
    }).returning();
    expect(person).toMatchObject({ id: 1, birthDate: "2000-01-01", heightCm: 170.123456789, dietFlags: ["vegetarian"] });
    const [view] = await db.insert(pg.savedViews).values({
      list: "recipes", name: "Fixture", query: "", createdAt: now, updatedAt: "2026-10-23T14:34:56.789+02:00",
    }).returning();
    expect(view).toMatchObject({ isDefault: false, createdAt: now, updatedAt: now, createdByPersonId: null });
    const [ingredient] = await db.insert(pg.ingredients).values({
      slug: "fixture", name: "Fixture", aliases: ["sample"], state: "ready",
      kcal: 100.123456789, proteinG: 5, carbsG: 10, fatG: 4, fibreG: 2,
      source: "CNF", sourceId: "fixture", aisle: "test", whereToBuy: [],
      isPantryStaple: true, containsOnionGarlic: false, isDairy: false,
    }).returning();
    expect(ingredient).toMatchObject({ kcal: 100.123456789, isPantryStaple: true, containsOnionGarlic: false });
  });

  it("keeps awaited writes atomic and rolls back after an asynchronous failure", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.insert(pg.syncState).values({ dataClass: "fixture", changedAt: now });
      expect(await tx.select().from(pg.syncState)).toHaveLength(1);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await db.select().from(pg.syncState)).toEqual([]);
    expect(await db.transaction(async (tx) => {
      await tx.insert(pg.syncState).values({ dataClass: "fixture", changedAt: now });
      return 42;
    })).toBe(42);
    expect(await db.select().from(pg.syncState)).toHaveLength(1);
  });

  it("enforces the exclusive photo subject and origin checks", async () => {
    const photo = { uid: "fixture", origin: "upload", sha256: "fixture", width: 100, height: 100, createdAt: now, updatedAt: now };
    await expect(db.insert(pg.photos).values(photo)).rejects.toThrow();
    await expect(db.insert(pg.photos).values({ ...photo, ingredientSlug: "fixture", origin: "invalid" })).rejects.toThrow();
    const [recipe] = await db.insert(pg.recipes).values({
      slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: [], cuisine: "test", isIndian: false,
      servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
    }).returning({ id: pg.recipes.id });
    await expect(db.insert(pg.photos).values({ ...photo, ingredientSlug: "fixture", recipeId: recipe!.id })).rejects.toThrow();
    await db.insert(pg.photos).values({ ...photo, ingredientSlug: "fixture" });
    expect(await db.select().from(pg.photos)).toHaveLength(1);
  });

  it("keeps candidate decisions unique per subject, not globally per photo", async () => {
    const decision = { candidateKey: "commons:fixture", subjectKind: "ingredient", subjectSlug: "fixture-a", decision: "rejected", createdAt: now, updatedAt: now };
    await db.insert(pg.photoDecisions).values({ ...decision, uid: "a" });
    await db.insert(pg.photoDecisions).values({ ...decision, uid: "b", subjectSlug: "fixture-b" });
    await expect(db.insert(pg.photoDecisions).values({ ...decision, uid: "c" })).rejects.toThrow();
    await expect(db.insert(pg.photoDecisions).values({ ...decision, uid: "d", subjectSlug: "fixture-c", decision: "invalid" })).rejects.toThrow();
    expect(await db.select().from(pg.photoDecisions)).toHaveLength(2);
  });

  it("preserves human-owned rows when their creator is removed", async () => {
    const [person] = await db.insert(pg.people).values({
      name: "Postgres fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170,
      weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: pg.people.id });
    await db.insert(pg.savedViews).values({ uid: "fixture", list: "recipes", name: "Fixture", query: "", createdByPersonId: person!.id });
    await db.delete(pg.people).where(eq(pg.people.id, person!.id));
    expect(await db.select().from(pg.savedViews)).toMatchObject([{ uid: "fixture", createdByPersonId: null }]);
  });

  it("enforces plan state values and cascades only the deleted plan's state", async () => {
    const [setup] = await db.insert(pg.planSetups).values({
      personIds: [], startDate: "2026-10-26", endDate: "2026-11-01", mealTypes: ["dinner"], cuisineBalance: 0.5, createdAt: now,
    }).returning({ id: pg.planSetups.id });
    const [plan] = await db.insert(pg.plans).values({ setupId: setup!.id, seed: 42, createdAt: now }).returning({ id: pg.plans.id });
    await expect(db.insert(pg.planPartState).values({ planId: plan!.id, componentSlug: "fixture", mode: "invalid", updatedAt: now })).rejects.toThrow();
    await expect(db.insert(pg.planProgress).values({ planId: plan!.id, step: "invalid", doneAt: now })).rejects.toThrow();
    await db.insert(pg.planPartState).values({ planId: plan!.id, componentSlug: "fixture", mode: "have", updatedAt: now });
    await db.insert(pg.planProgress).values({ planId: plan!.id, step: "reviewed", doneAt: now });
    await db.delete(pg.plans).where(eq(pg.plans.id, plan!.id));
    expect(await db.select().from(pg.planPartState)).toEqual([]);
    expect(await db.select().from(pg.planProgress)).toEqual([]);
    expect(await db.select().from(pg.planSetups)).toHaveLength(1);
  });
});
