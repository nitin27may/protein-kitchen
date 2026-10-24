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
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { readAccountExport } from "../lib/server/account-export";
import { persistNewPlan, persistRegeneratedPlan } from "../lib/server/plan-persistence";
import { createSqliteSource } from "./helpers/sqlite-source";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";
import { acceptInvitation, changeMemberRole, claimHousehold, createMemberProfile, issueInvitation, removeHouseholdMember } from "../lib/auth/household";
import { createAuth } from "../lib/auth/create";

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

  it("preserves independent concurrent favourite/rating patches and another cook's feedback", async () => {
    const people = await handle.db.insert(s.people).values(["First", "Second"].map((name) => ({
      name, sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
    }))).returning();
    const [recipe] = await handle.db.insert(s.recipes).values({
      slug: "concurrent-feedback", name: "Synthetic bowl", family: "bowls", kind: "recipe", mealSlots: ["lunch"], cuisine: "global",
      servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, fridgeDays: 2, isIndian: false, equipment: [], tags: [],
    }).returning();
    await writeRecipeFeedback(handle.db, recipe!.id, { rating: 4, favourite: true });
    await Promise.all([
      writePersonalRecipeFeedback(handle.db, people[0]!.id, recipe!.id, { favourite: true }),
      writePersonalRecipeFeedback(handle.db, people[0]!.id, recipe!.id, { rating: 5 }),
      writePersonalRecipeFeedback(handle.db, people[1]!.id, recipe!.id, { rating: 2 }),
    ]);
    expect(await handle.db.select().from(s.personRecipeFeedback).orderBy(s.personRecipeFeedback.personId)).toMatchObject([
      { personId: people[0]!.id, rating: 5, favourite: true }, { personId: people[1]!.id, rating: 2, favourite: false },
    ]);
    expect(await handle.db.select().from(s.recipeFeedback)).toMatchObject([{ rating: 4, favourite: true, status: "tested" }]);
    expect(await handle.db.select().from(s.syncState).where(eq(s.syncState.dataClass, "personal-recipe-feedback"))).toHaveLength(1);
  });

  it("reads a session-bound personal account export using a native read-only snapshot", async () => {
    const profiles = await handle.db.insert(s.people).values(["first", "second"].map((name) => ({
      name: `Synthetic ${name} profile`, sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light" as const, dietFlags: [],
    }))).returning();
    await handle.db.insert(s.authUsers).values(["first", "second"].map((id) => ({
      id, name: `Synthetic ${id} cook`, email: `${id}@example.test`, emailVerified: true,
    })));
    await handle.db.insert(s.householdMembers).values(profiles.map((person, index) => ({
      userId: index ? "second" : "first", personId: person.id, role: "member" as const,
    })));
    const account = await readAccountExport(handle.db, { userId: "first", personId: profiles[0]!.id });
    expect(account).toMatchObject({
      account: { email: "first@example.test" }, profile: { name: "Synthetic first profile" }, feedback: [], preferences: [], routines: [],
    });
    expect(JSON.stringify(account)).not.toContain("Synthetic second");
    expect(await readAccountExport(handle.db, { userId: "first", personId: profiles[1]!.id })).toBeUndefined();
  });

  it("serializes competing bootstrap claims across real pool connections", async () => {
    await handle.db.insert(s.authUsers).values(["first", "second"].map((id) => ({
      id, name: "Synthetic concurrent cook", email: `${id}@example.test`, emailVerified: true,
    })));
    const secret = "synthetic-bootstrap-concurrency-secret";
    const claims = await Promise.allSettled(["first", "second"].map((id) => claimHousehold(handle.db, id, secret, secret)));
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = claims.find((r) => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason.message).toContain("already been claimed");
    expect(await handle.db.select().from(s.householdBootstrap)).toHaveLength(1);
    expect(await handle.db.select().from(s.householdMembers)).toHaveLength(1);
  });

  it.each(["demote", "remove", "mixed"])("preserves a final owner under concurrent %s requests", async (operation) => {
    await handle.db.insert(s.authUsers).values(["first", "second"].map((id) => ({
      id, name: "Synthetic concurrent owner", email: `${id}@example.test`, emailVerified: true,
    })));
    const input = {
      name: "Synthetic owner profile", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light" as const, proteinMode: "per_kg" as const, proteinValue: 1.2, kcalTarget: null, reminderTime: null,
    };
    const secret = "synthetic-bootstrap-concurrency-secret";
    await claimHousehold(handle.db, "first", secret, secret);
    await createMemberProfile(handle.db, "first", input);
    const invite = await issueInvitation(handle.db, "first", { email: "second@example.test" });
    await acceptInvitation(handle.db, "second", invite.token);
    await createMemberProfile(handle.db, "second", input);
    await changeMemberRole(handle.db, "first", "second", "owner");
    const results = await Promise.allSettled(["first", "second"].map((id, index) =>
      operation === "remove" || (operation === "mixed" && index === 0)
        ? removeHouseholdMember(handle.db, id, id)
        : changeMemberRole(handle.db, id, id, "member")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toContain("at least one verified owner");
    expect(await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.role, "owner"))).toHaveLength(1);
    expect(await handle.db.select().from(s.people)).toHaveLength(2);
  });

  it("atomically consumes one invitation and reserves each meal profile for one account", async () => {
    await handle.db.insert(s.authUsers).values(["owner", "cook"].map((id) => ({
      id, name: "Synthetic concurrent cook", email: `${id}@example.test`, emailVerified: true,
    })));
    const secret = "synthetic-bootstrap-concurrency-secret";
    await claimHousehold(handle.db, "owner", secret, secret);
    const [person] = await handle.db.insert(s.people).values({
      name: "Synthetic profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [],
    }).returning();
    const issues = await Promise.allSettled(["cook", "other"].map((id) => issueInvitation(handle.db, "owner", {
      email: `${id}@example.test`, personId: person!.id,
    })));
    expect(issues.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const issued = issues.find((r) => r.status === "fulfilled");
    if (issued?.status !== "fulfilled") throw new Error("Expected one concurrent invitation.");
    await handle.db.update(s.authUsers).set({ email: issued.value.email }).where(eq(s.authUsers.id, "cook"));
    const accepts = await Promise.allSettled([
      acceptInvitation(handle.db, "cook", issued.value.token), acceptInvitation(handle.db, "cook", issued.value.token),
    ]);
    expect(accepts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await handle.db.select().from(s.householdMembers)).toHaveLength(2);
    expect(await handle.db.select().from(s.householdInvitations)).toMatchObject([{
      acceptedByUserId: "cook", acceptedAt: expect.any(Date),
    }]);
  });

  it("creates exactly one linked profile across simultaneous onboarding submissions", async () => {
    await handle.db.insert(s.authUsers).values({
      id: "owner", name: "Synthetic owner", email: "owner@example.test", emailVerified: true,
    });
    const secret = "synthetic-bootstrap-concurrency-secret";
    await claimHousehold(handle.db, "owner", secret, secret);
    const input = {
      name: "Synthetic targets", sex: "other" as const, birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light" as const, proteinMode: "fixed" as const, proteinValue: 95, kcalTarget: null, reminderTime: null,
    };
    const results = await Promise.allSettled([
      createMemberProfile(handle.db, "owner", input), createMemberProfile(handle.db, "owner", input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toContain("already has a profile");
    const profiles = await handle.db.select().from(s.people);
    expect(profiles).toHaveLength(1);
    expect(await handle.db.select().from(s.householdMembers)).toMatchObject([{ personId: profiles[0]!.id }]);
  });

  it("atomically enforces shared HTTP signup limits across concurrent auth instances", async () => {
    const options = {
      secret: "synthetic-native-auth-session-secret",
      baseURL: "http://localhost:3112", isVercel: false, sendCode: async () => {},
    };
    const instances = [createAuth(handle.db, options), createAuth(handle.db, options)];
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => instances[index % 2]!.handler(new Request(
      "http://localhost:3112/api/auth/sign-up/email", {
        method: "POST", headers: {
          origin: "http://localhost:3112", "content-type": "application/json", "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ name: "Synthetic cook", email: `${index}@example.test`, password: "Synthetic-password-123!" }),
      },
    ))));
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await handle.db.select().from(s.authUsers)).toEqual([]);
    expect(await handle.db.select().from(s.authRateLimits)).toMatchObject([{ count: 3 }]);
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
