import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openPostgres } from "../lib/db/postgres/client";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";
import { loadData } from "../lib/data/load";
import { seedDatabase } from "../lib/db/seed";
import { exportHumanData } from "../lib/human/export";
import { writeRecipeFeedback } from "../lib/human/feedback";
import { persistNewPlan, persistRegeneratedPlan } from "../lib/server/plan-persistence";
import { createSqliteSource } from "./helpers/sqlite-source";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";

const url = process.env.POSTGRES_TEST_URL;
let handle: ReturnType<typeof openPostgres>;
const at = "2026-10-23T12:00:00.000Z";

describe.skipIf(!url)("node-postgres on disposable native Postgres", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.pathname !== "/protein_kitchen_test") {
      throw new Error("Integration tests require a loopback-only protein_kitchen_test database.");
    }
    handle = openPostgres({ connectionString: url!, runtimeEnvironment: "test", databaseEnvironment: "test" });
    await migrate(handle.db, { migrationsFolder: path.resolve("db/postgres-migrations") });
  });
  afterEach(async () => {
    if (handle) await handle.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
  });
  afterAll(async () => { if (handle) await handle.close(); });

  it("commits awaited writes, rolls back rejection and reuses the pool after failure", async () => {
    await expect(withTx(handle.db, async (tx) => {
      await tx.insert(s.syncState).values({ dataClass: "rollback", changedAt: at });
      await tx.execute(sql`select pg_sleep(0.01)`);
      throw new Error("native rollback");
    })).rejects.toThrow("native rollback");
    expect(await handle.db.select().from(s.syncState)).toEqual([]);
    expect(await withTx(handle.db, async (tx) => {
      await tx.insert(s.syncState).values({ dataClass: "commit", changedAt: at });
      return 42;
    })).toBe(42);
  });

  it("keeps concurrent row-locked updates isolated across pool connections", async () => {
    await handle.db.insert(s.libraryState).values({ key: "counter", version: "0" });
    await Promise.all(Array.from({ length: 8 }, () => withTx(handle.db, async (tx) => {
      const [row] = await tx.select().from(s.libraryState).where(eq(s.libraryState.key, "counter")).for("update");
      await tx.execute(sql`select pg_sleep(0.005)`);
      await tx.update(s.libraryState).set({ version: String(Number(row!.version) + 1) }).where(eq(s.libraryState.key, "counter"));
    })));
    expect(await handle.db.select().from(s.libraryState)).toMatchObject([{ key: "counter", version: "8" }]);
  });

  it("seeds the library and preserves human exports through a native reseed", async () => {
    const data = loadData(process.cwd());
    await seedDatabase(handle.db, data);
    const [recipe] = await handle.db.select().from(s.recipes).limit(1);
    await writeRecipeFeedback(handle.db, recipe!.id, { notes: "Synthetic native fixture" });
    const before = await exportHumanData(handle.db);
    await seedDatabase(handle.db, data);
    expect(await exportHumanData(handle.db)).toEqual(before);
  });

  it("serializes simultaneous regenerations so the final plan never mixes two replacements", async () => {
    const [person] = await handle.db.insert(s.people).values({
      name: "Native concurrency fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [],
    }).returning();
    const [recipe] = await handle.db.insert(s.recipes).values({
      slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"], cuisine: "test",
      isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
    }).returning();
    const recipeIds = new Map([["fixture", recipe!.id]]);
    const slot = (date: string) => ({
      date, slot: "dinner" as const, recipeSlug: "fixture", servings: { [person!.id]: 1 }, locked: false, reasons: [],
    });
    const planId = await persistNewPlan(handle.db, {
      setup: {
        personIds: [person!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"], cuisineBalance: 0.5,
        maxActiveMin: null, healthFocus: { nutrientDense: true, lowSugar: true, light: true }, prepStyle: "variety", createdAt: at,
      },
      seed: 1, slots: [slot("2026-11-02")], routines: [], recipeIds,
    });
    await Promise.all([
      persistRegeneratedPlan(handle.db, planId, 2, [slot("2026-11-03")], recipeIds),
      persistRegeneratedPlan(handle.db, planId, 3, [slot("2026-11-04")], recipeIds),
    ]);
    const [plan] = await handle.db.select().from(s.plans);
    expect(await handle.db.select().from(s.planSlots)).toMatchObject([{ planId, date: plan!.seed === 2 ? "2026-11-03" : "2026-11-04" }]);
    expect(await handle.db.select().from(s.planSlotPortions)).toHaveLength(1);
  });

  it("imports all 33 SQLite tables, repairs identities and repeats into a fresh destination", async () => {
    const source = createSqliteSource();
    try {
      const snapshot = readSqliteSnapshot(source.file);
      for (let rehearsal = 0; rehearsal < 2; rehearsal++) {
        expect(await restoreSqliteSnapshot(handle.db, snapshot)).toEqual(snapshot.tables);
        expect(await handle.db.select().from(s.recipeFeedback)).toMatchObject([{ uid: "feedback-fixture", favourite: true }]);
        const [person] = await handle.db.insert(s.people).values({
          name: "Next identity fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
          activityLevel: "light", dietFlags: [],
        }).returning();
        expect(person!.id).toBe(301);
        await handle.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
      }
    } finally { source.close(); }
  });

  it("serializes competing imports; exactly one commits and the other refuses populated tables", async () => {
    const source = createSqliteSource();
    try {
      const snapshot = readSqliteSnapshot(source.file);
      const results = await Promise.allSettled([
        restoreSqliteSnapshot(handle.db, snapshot), restoreSqliteSnapshot(handle.db, snapshot),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect(failed?.status === "rejected" && failed.reason.message).toContain("empty destination");
      expect(await handle.db.select().from(s.people)).toHaveLength(1);
      expect(await handle.db.select().from(s.photos)).toHaveLength(1);
    } finally { source.close(); }
  });

  it("rolls back native identity repair on failure and can retry without sequence collisions", async () => {
    const source = createSqliteSource();
    try {
      source.sqlite.exec("UPDATE photo_decisions SET id = 2147483647");
      await expect(restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file))).rejects.toThrow("Identity range exhausted");
      expect(await handle.db.select().from(s.ingredients)).toEqual([]);
      const result = await handle.pool.query("SELECT nextval('ingredients_id_seq')::integer AS n");
      expect(result.rows[0]!.n).toBe(1);
      source.sqlite.exec("UPDATE photo_decisions SET id = 660");
      const snapshot = readSqliteSnapshot(source.file);
      expect(await restoreSqliteSnapshot(handle.db, snapshot)).toEqual(snapshot.tables);
    } finally { source.close(); }
  });

  it("preserves restored human exports through the required explicit library seed", async () => {
    const source = createSqliteSource();
    try {
      await restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file));
      const before = await exportHumanData(handle.db);
      await seedDatabase(handle.db, loadData(process.cwd()));
      expect(await exportHumanData(handle.db)).toEqual(before);
      expect(await handle.db.select().from(s.libraryState)).toHaveLength(1);
      expect(await handle.db.select().from(s.planSlotPortions)).toMatchObject([{ planSlotId: 600, personId: 300, servings: 1.25 }]);
    } finally { source.close(); }
  });

  it("runs the real import CLI, prints only verification metadata and refuses a repeated invocation", async () => {
    const source = createSqliteSource();
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/import-sqlite.ts", source.file], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_ENV: "test", DATABASE_URL_UNPOOLED: url },
    });
    try {
      const result = await run();
      expect(result.stdout).toContain("verified and committed");
      expect(result.stdout).toContain("photos: 1 rows, sha256");
      expect(result.stdout).not.toContain("Synthetic human note");
      expect(result.stderr).toBe("");
      await expect(run()).rejects.toMatchObject({ stderr: expect.stringContaining("requires an empty destination") });
      expect(await handle.db.select().from(s.people)).toHaveLength(1);
    } finally { source.close(); }
  });
});
