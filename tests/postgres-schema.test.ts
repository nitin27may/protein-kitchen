import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import * as pg from "../lib/db/postgres/schema";
import * as sqlite from "../lib/db/sqlite-schema";

type PostgresRows = { [K in keyof typeof sqlite]: (typeof pg)[K]["$inferSelect"] };
type SQLiteRows = { [K in keyof typeof sqlite]: (typeof sqlite)[K]["$inferSelect"] };

describe("Postgres baseline parity", () => {
  it("preserves every application row type", () => {
    expectTypeOf<PostgresRows>().toEqualTypeOf<SQLiteRows>();
  });

  it("preserves all tables, columns, nullability, keys, indexes and foreign-key deletion behavior", () => {
    const postgresOnly = ["libraryState", "authUsers", "authSessions", "authAccounts", "authVerifications", "authRateLimits",
      "householdBootstrap", "householdMembers", "householdInvitations"];
    expect(Object.keys(pg).filter((key) => !postgresOnly.includes(key)).sort()).toEqual(Object.keys(sqlite).sort());
    for (const name of Object.keys(sqlite) as (keyof typeof sqlite)[]) {
      const source = sqliteConfig(sqlite[name]);
      const target = pgConfig(pg[name]);
      expect(target.name, name).toBe(source.name);
      const columns = (config: typeof source | typeof target) => config.columns.map((c) => ({
        name: c.name, notNull: c.notNull, primary: c.primary, unique: c.isUnique,
        enum: c.enumValues, default: c.default,
      })).sort((a, b) => a.name.localeCompare(b.name));
      expect(columns(target), name).toEqual(columns(source));
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
      expect(target.checks.map((c) => c.name).sort(), name).toEqual(source.checks.map((c) => c.name).sort());
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
  it("creates every table and can be applied twice without replaying the baseline", async () => {
    await migrate(db, { migrationsFolder });
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    expect(result.rows.map((r) => r.table_name).sort()).toEqual(Object.values(pg).map(getTableName).sort());
    const journal = await client.query("select * from drizzle.__drizzle_migrations");
    expect(journal.rows).toHaveLength(4);
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
