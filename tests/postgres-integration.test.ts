import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openPostgres } from "../lib/db/postgres/client";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";
import { loadData } from "../lib/data/load";
import { seedDatabase } from "../lib/db/seed";
import { exportHumanData } from "../lib/human/export";
import { writeRecipeFeedback } from "../lib/human/feedback";
import { savedViewsClass, writeSavedView } from "../lib/human/saved-views";
import { markChanged } from "../lib/human/util";
import { acknowledgeStateSnapshot, captureStateSnapshot, readStateSyncStatus } from "../lib/sync/snapshot";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { readAccountExport } from "../lib/server/account-export";
import { persistNewPlan, persistRegeneratedPlan } from "../lib/server/plan-persistence";
import { createSqliteSource } from "./helpers/sqlite-source";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";
import { acceptInvitation, changeMemberRole, claimHousehold, createMemberProfile, deleteOwnAccount, issueInvitation, removeHouseholdMember } from "../lib/auth/household";
import { createAuth } from "../lib/auth/create";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createFsStore } from "../lib/blob/fs";
import { photoKeys } from "../lib/photos/keys";
import { digestRows } from "../lib/db/sqlite-snapshot";
import { runStateSync, stateTargetKey } from "../lib/sync/run";
import { createMemoryStore } from "../lib/blob/memory";
import { openPrivateStateRepository } from "../lib/sync/github";
import { fixtureConfiguration as syncConfig, fixtureTime, githubFixture } from "./helpers/github-state";
import { claimReminder } from "../lib/reminders/claim";
import { claimDelivery, finishDelivery, prepareReminderBatch } from "../lib/reminders/delivery";

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

  it("admits one reminder sender across eight concurrent native pool requests and preserves legacy daily claims", async () => {
    const source = createSqliteSource();
    try {
      await restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file));
      const [legacy] = await handle.db.select().from(s.reminderLog);
      expect(legacy).toBeDefined();
      expect(await claimReminder(handle.db, legacy!)).toBe(false);
      const reminder = { personId: 300, date: "2099-11-01", sentAt: at };
      const results = await Promise.all(Array.from({ length: 8 }, () => claimReminder(handle.db, reminder)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await claimReminder(handle.db, { ...reminder, sentAt: "2026-11-01T22:00:00.000Z" })).toBe(false);
      expect(await handle.db.select().from(s.reminderLog).where(eq(s.reminderLog.date, reminder.date))).toEqual([reminder]);
      expect(await claimReminder(handle.db, { ...reminder, date: "2099-11-02" })).toBe(true);
    } finally { source.close(); }
  });

  it("freezes one batch and admits exactly one fenced device attempt across native connections", async () => {
    await handle.db.insert(s.people).values({
      id: 1, name: "Synthetic reminder cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [], reminderTime: "21:00",
    });
    await handle.db.insert(s.authUsers).values({ id: "reminder-user", name: "Synthetic cook", email: "native-reminder@example.test", emailVerified: true });
    await handle.db.insert(s.householdMembers).values({ userId: "reminder-user", personId: 1, role: "owner" });
    await handle.db.insert(s.authSessions).values({
      id: "reminder-session", userId: "reminder-user", token: "native-synthetic-reminder-session",
      expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(),
    });
    await handle.db.insert(s.pushSubscriptions).values({
      id: 1, personId: 1, endpoint: "https://push.example.test/native", p256dh: "synthetic", auth: "synthetic", createdAt: at,
    });
    const input = { personId: 1, householdTimezone: "UTC", payload: { title: "Synthetic", body: "Synthetic", url: "/" }, now: new Date("2099-11-01T21:00:00Z") };
    const batches = await Promise.all(Array.from({ length: 8 }, () => prepareReminderBatch(handle.db, input)));
    expect(new Set(batches).size).toBe(1);
    const batchId = batches[0]!;
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDelivery(handle.db, batchId, 1)));
    const winner = claims.find((v) => v !== undefined)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await finishDelivery(handle.db, { ...winner, token: randomUUID() }, "accepted")).toBe(false);
    expect(await finishDelivery(handle.db, winner, "accepted")).toBe(true);
    expect(await claimDelivery(handle.db, batchId, 1)).toBeUndefined();
    const second = (await prepareReminderBatch(handle.db, { ...input, now: new Date("2099-11-02T21:00:00Z") }))!;
    const interrupted = (await claimDelivery(handle.db, second, 1))!;
    await handle.db.update(s.reminderDeliveries).set({ attemptedAt: at }).where(eq(s.reminderDeliveries.batchId, second));
    const stale = await Promise.all(Array.from({ length: 8 }, () => claimDelivery(handle.db, second, 1)));
    expect(stale.every((v) => v === undefined)).toBe(true);
    expect(await finishDelivery(handle.db, interrupted, "accepted")).toBe(false);
    const third = (await prepareReminderBatch(handle.db, { ...input, now: new Date("2099-11-03T21:00:00Z") }))!;
    await handle.db.delete(s.householdMembers);
    expect(await claimDelivery(handle.db, third, 1)).toBeUndefined();
    expect(await handle.db.select().from(s.reminderDeliveries).where(eq(s.reminderDeliveries.batchId, third))).toMatchObject([{ status: "cancelled" }]);
  });

  it("keeps concurrent same-timestamp writes pending across stale and racing sync acknowledgements", async () => {
    const first = await captureStateSnapshot(handle.db, ["saved-views"]);
    await Promise.all(Array.from({ length: 8 }, () => withTx(handle.db, (tx) => markChanged(tx, "saved-views", at))));
    expect(await acknowledgeStateSnapshot(handle.db, first.revisions)).toEqual([]);
    expect(await readStateSyncStatus(handle.db, ["saved-views"])).toMatchObject([
      { revision: 9, exportedRevision: 0, changedAt: at, pending: true },
    ]);
    const second = await captureStateSnapshot(handle.db, ["saved-views"]);
    await Promise.all([
      acknowledgeStateSnapshot(handle.db, second.revisions),
      withTx(handle.db, (tx) => markChanged(tx, "saved-views", at)),
    ]);
    const [status] = await readStateSyncStatus(handle.db, ["saved-views"]);
    expect(status).toMatchObject({ revision: 10, pending: true });
    expect(status!.exportedRevision).toBeLessThan(10);
  });

  it("exports files and receipts from the same snapshot while another connection edits that class", async () => {
    await writeSavedView(handle.db, { list: "recipes", query: "original" });
    const original = savedViewsClass.exportFiles;
    const exportSpy = vi.spyOn(savedViewsClass, "exportFiles").mockImplementationOnce(async (snapshotDb) => {
      await writeSavedView(handle.db, { list: "recipes", query: "changed-on-another-connection" });
      return original(snapshotDb);
    });

    try {
      const snapshot = await captureStateSnapshot(handle.db, ["saved-views"]);
      expect(Object.values(snapshot.bundle.files)).toHaveLength(1);
      expect(Object.values(snapshot.bundle.files)[0]).toContain('"query": "original"');
      expect(snapshot.revisions).toEqual({ "saved-views": 1 });
      expect(await acknowledgeStateSnapshot(handle.db, snapshot.revisions)).toEqual([]);
      expect(await readStateSyncStatus(handle.db, ["saved-views"])).toMatchObject([{ revision: 2, exportedRevision: 0, pending: true }]);
    } finally { exportSpy.mockRestore(); }
  });

  it("serializes real concurrent sync acquisition and fences a stale worker after another connection takes over", async () => {
      const fixture = githubFixture(); fixture.reset(); await fixture.start();
      const target = stateTargetKey(syncConfig);
      const store = createMemoryStore();
      const repository = () => openPrivateStateRepository(syncConfig, fixture.fetch, () => fixtureTime);
      const ready = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const oldId = randomUUID();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const old = runStateSync(handle.db, target, ["saved-views"], {
          store, repository: async () => { ready.resolve(); await resume.promise; return repository(); },
        }, oldId);
        await ready.promise;
        expect(await runStateSync(handle.db, target, ["saved-views"], { repository, store })).toEqual({ state: "busy", replayed: false });
        expect(fixture.requests).toEqual([]);
        await handle.db.update(s.stateSyncJobs).set({ leaseExpiresAt: at }).where(eq(s.stateSyncJobs.targetKey, target));
        expect(await runStateSync(handle.db, target, ["saved-views"], { repository, store })).toMatchObject({ state: "success" });
        const successful = (await handle.db.select().from(s.stateSyncJobs))[0]!;
        resume.resolve();
        expect(await old).toMatchObject({ state: "error" });
        expect(await handle.db.select().from(s.stateSyncJobs)).toEqual([successful]);
        expect(await handle.db.select().from(s.stateSyncRequests).where(eq(s.stateSyncRequests.id, oldId))).toMatchObject([{ status: "error" }]);
        expect(await readStateSyncStatus(handle.db, ["saved-views"])).toMatchObject([{ pending: false, exportedRevision: 1 }]);
      } finally { resume.resolve(); errors.mockRestore(); await fixture.close(); }
  });

  it("does not let racing requests bind a single idempotency key to two different targets", async () => {
      const id = randomUUID();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const repository = async () => { throw new Error("Synthetic offline repository"); };
        const results = await Promise.allSettled(["a", "b"].map((key) =>
          runStateSync(handle.db, key.repeat(64), ["saved-views"], { repository, store: createMemoryStore() }, id)));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(await handle.db.select().from(s.stateSyncJobs)).toHaveLength(1);
        expect(await handle.db.select().from(s.stateSyncRequests)).toHaveLength(1);
      } finally { errors.mockRestore(); }
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

  it.each(["demote", "remove", "mixed", "delete", "delete-demote", "delete-remove"])("preserves a final owner under concurrent %s requests", async (operation) => {
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
    if (operation.startsWith("delete")) {
      for (const id of ["first", "second"]) {
        await handle.db.insert(s.authSessions).values({ id, userId: id, token: `${id}-token`, updatedAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
        await handle.db.insert(s.authAccounts).values({ id, userId: id, accountId: id, providerId: "credential", password: "synthetic-hash", updatedAt: new Date() });
      }
    }
    const results = await Promise.allSettled(["first", "second"].map((id, index) => {
      if (operation === "delete" || (operation.startsWith("delete-") && index === 0)) {
        return deleteOwnAccount(handle.db, { userId: id, sessionToken: `${id}-token`, password: "synthetic", verifyPassword: async () => true });
      }
      return operation === "remove" || operation === "delete-remove" || (operation === "mixed" && index === 0)
        ? removeHouseholdMember(handle.db, id, id)
        : changeMemberRole(handle.db, id, id, "member");
    }));
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

  it.each([true, false])("runs real encrypted backup/restore CLIs with full table parity (photos: %s)", async (hasPhotos) => {
    const exec = promisify(execFile);
    const source = createSqliteSource();
    await mkdir("backups", { recursive: true });
    const folder = await mkdtemp(path.resolve("backups/native-recovery-"));
    const identity = path.join(folder, "synthetic-identity.txt");
    const wrongIdentity = path.join(folder, "synthetic-wrong-identity.txt");
    const age = process.env.AGE_TEST_BIN || "age";
    const keygen = process.env.AGE_KEYGEN_TEST_BIN || "age-keygen";
    const database = `protein_kitchen_restore_${randomUUID().replaceAll("-", "")}`;
    const restoredUrl = new URL(url!); restoredUrl.pathname = `/${database}`;
    let restored: ReturnType<typeof openPostgres> | undefined;
    let created = false;
    try {
      await restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file));
      await handle.db.update(s.people).set({ name: "PRIVATE_RECOVERY_SENTINEL" });
      await handle.db.insert(s.authUsers).values({ id: "synthetic-recovery-account", name: "PRIVATE_ACCOUNT_SENTINEL", email: "recovery@example.test", emailVerified: true });
      const operationalBatch = randomUUID();
      await handle.db.insert(s.reminderBatches).values({
        id: operationalBatch, personId: 300, date: "2099-01-01", payload: { title: "PRIVATE_REMINDER_SENTINEL", body: "Private", url: "/" },
        createdAt: at, expiresAt: at,
      });
      await handle.db.insert(s.reminderDeliveries).values({
        batchId: operationalBatch, subscriptionId: 1234, fingerprint: "synthetic", status: "sending", attempts: 1, updatedAt: at,
      });
      const uid = randomUUID();
      const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#884422" } }).webp().toBuffer();
      await handle.db.update(s.photos).set({ uid, sha256: createHash("sha256").update(bytes).digest("hex"), width: 20, height: 20 });
      if (!hasPhotos) await handle.db.delete(s.photos);
      const photoStore = createFsStore(path.join(folder, "uploads"));
      const keys = photoKeys(uid);
      await photoStore.put(keys.master, bytes, "image/webp"); await photoStore.put(keys.thumb, bytes, "image/webp");
      const human = await exportHumanData(handle.db);
      const tables = Object.values(s).filter((table) => table !== s.stateSyncJobs && table !== s.stateSyncRequests &&
        table !== s.reminderBatches && table !== s.reminderDeliveries);
      const before = await Promise.all(tables.map(async (table) => ({ table: getTableName(table), ...digestRows(await handle.db.select().from(table)) })));
      await exec(keygen, ["--output", identity]);
      await exec(keygen, ["--output", wrongIdentity]);
      const recipient = (await exec(keygen, ["-y", identity])).stdout.trim();
      const outputRoot = path.join(folder, "encrypted");
      const result = await exec(process.execPath, ["--import", "tsx", "scripts/backup-postgres.ts"], {
        env: {
          ...process.env, NODE_ENV: "test", DATABASE_ENV: "test", DATABASE_URL_UNPOOLED: url,
          BACKUP_AGE_RECIPIENT: recipient, BACKUP_OUTPUT_DIR: outputRoot, AGE_BIN: age,
          PG_DUMP_BIN: process.env.PG_DUMP_TEST_BIN || "pg_dump",
          BLOB_STORE: "filesystem", UPLOADS_DIR: path.join(folder, "uploads"), VERCEL: "", VERCEL_ENV: "",
        },
      });
      expect(result.stdout).toContain("Encrypted local recovery artifact written");
      expect(result.stdout).toContain("not an off-machine backup");
      expect(result.stdout).not.toMatch(/PRIVATE_|postgres:|AGE-SECRET/);
      const [name] = await readdir(outputRoot);
      const artifact = path.join(outputRoot, name!);
      const index = JSON.parse(await readFile(path.join(artifact, "index.json"), "utf8"));
      expect(JSON.stringify(index)).not.toMatch(/PRIVATE_|photos\/|AGE-SECRET/);
      const decrypt = (file: string, key = identity) => exec(age, ["--decrypt", "--identity", key, path.join(artifact, file)], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      const manifest = JSON.parse((await decrypt("manifest.json.age")).stdout.toString());
      const recoveredStore = createMemoryStore();
      let dump: Buffer | undefined;
      for (const item of manifest.contents) {
        const content = (await decrypt(item.file)).stdout;
        expect(createHash("sha256").update(content).digest("hex")).toBe(item.sha256);
        expect(content.byteLength).toBe(item.size);
        if (item.key === "database.dump") dump = content;
        else await recoveredStore.put(item.key, content, "image/webp");
      }
      expect(dump!.subarray(0, 5).toString()).toBe("PGDMP");
      await expect(decrypt("database.dump.age", wrongIdentity)).rejects.toThrow();
      const corrupt = await readFile(path.join(artifact, "database.dump.age"));
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      await writeFile(path.join(artifact, "corrupt.age"), corrupt);
      await expect(decrypt("corrupt.age")).rejects.toThrow();
      await handle.db.execute(sql`CREATE DATABASE ${sql.identifier(database)}`); created = true;
      const photoDirectory = path.join(folder, "recovered-photos");
      const runRestore = (destination = restoredUrl.toString(), key = identity, trust = "--trust-artifact") => exec(process.execPath, [
        "--import", "tsx", "scripts/restore-postgres.ts", artifact, key, photoDirectory, trust,
      ], {
        env: {
          ...process.env, NODE_ENV: "test", DATABASE_ENV: "test", RESTORE_DATABASE_URL: destination,
          DATABASE_URL_UNPOOLED: url, AGE_BIN: age, PG_RESTORE_BIN: process.env.PG_RESTORE_TEST_BIN || "pg_restore", VERCEL: "", VERCEL_ENV: "",
        },
      });
      await expect(runRestore(url)).rejects.toMatchObject({ stderr: expect.stringContaining("destination-refused") });
      await expect(runRestore(restoredUrl.toString(), identity, "--untrusted")).rejects.toMatchObject({ stderr: expect.stringContaining("destination-refused") });
      await expect(runRestore(restoredUrl.toString(), wrongIdentity)).rejects.toMatchObject({ stderr: expect.stringContaining("decryption-failed") });
      const ciphertext = await readFile(path.join(artifact, "database.dump.age"));
      await writeFile(path.join(artifact, "database.dump.age"), corrupt);
      await expect(runRestore()).rejects.toMatchObject({ stderr: expect.stringContaining("artifact-invalid") });
      await writeFile(path.join(artifact, "database.dump.age"), ciphertext);
      restored = openPostgres({ connectionString: restoredUrl.toString(), runtimeEnvironment: "test", databaseEnvironment: "test" });
      await restored.pool.query("CREATE FUNCTION public.synthetic_nonempty() RETURNS integer LANGUAGE SQL AS 'SELECT 1'");
      await expect(runRestore()).rejects.toMatchObject({ stderr: expect.stringContaining("destination-refused") });
      await restored.pool.query("DROP FUNCTION public.synthetic_nonempty()");
      const recovery = await runRestore();
      expect(recovery.stdout).toContain("Isolated recovery verified:");
      expect(recovery.stdout).not.toMatch(/PRIVATE_|postgres:|AGE-SECRET/);
      await expect(runRestore()).rejects.toMatchObject({ stderr: expect.stringContaining("destination-refused") });
      const after = await Promise.all(tables.map(async (table) => ({ table: getTableName(table), ...digestRows(await restored!.db.select().from(table)) })));
      expect(after).toEqual(before);
      expect(await restored.db.select().from(s.reminderBatches)).toEqual([]);
      expect(await restored.db.select().from(s.reminderDeliveries)).toEqual([]);
      expect(await exportHumanData(restored.db)).toEqual(human);
      const restoredPhotos = createFsStore(photoDirectory);
      if (hasPhotos) {
        expect((await recoveredStore.get(keys.master))!.bytes).toEqual(new Uint8Array(bytes));
        expect((await recoveredStore.get(keys.thumb))!.bytes).toEqual(new Uint8Array(bytes));
        expect(Buffer.from((await restoredPhotos.get(keys.master))!.bytes)).toEqual(bytes);
        expect(Buffer.from((await restoredPhotos.get(keys.thumb))!.bytes)).toEqual(bytes);
      } else {
        expect(await recoveredStore.list()).toEqual([]);
        expect(await restoredPhotos.list()).toEqual([]);
      }
    } finally {
      if (restored) await restored.close();
      if (created) await handle.db.execute(sql`DROP DATABASE ${sql.identifier(database)}`);
      source.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
