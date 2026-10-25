import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { openPostgres } from "../lib/db/postgres/client";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";
import { loadData } from "../lib/data/load";
import { applyRenames } from "../lib/db/renames";
import { seedDatabase } from "../lib/db/seed";
import { exportHumanData } from "../lib/human/export";
import { importHumanData } from "../lib/human/import";
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
import {
  acceptEmailAssociation, acceptInvitation, addEmailAssociation, changeMemberRole, claimHousehold,
  createMemberProfile, deleteOwnAccount, issueInvitation, removeHouseholdMember, revokeInvitation,
} from "../lib/auth/household";
import { createAuth, type AuthLinkMail } from "../lib/auth/create";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { fetchEncryptedVault, publishEncryptedVault } from "../lib/backup/vault";
import { resolveHouseholdAccess } from "../lib/auth/household-access";
import { createSessionHousehold, resolveSessionHouseholdAccess, selectSessionHousehold } from "../lib/auth/household-session";
import { deleteHouseholdPlan, householdPlan, householdPlans, mutateHouseholdPlan, mutateHouseholdPerson, mutateHouseholdState, persistHouseholdPlan, regenerateHouseholdPlan } from "../lib/server/household-plans";
import { writeLink } from "../lib/human/links";
import { approveCandidate, writeUploadedPhoto, type PhotoWriteScope } from "../lib/human/photos";
import { changeHouseholdDefaultView, defaultViewQuery } from "../lib/server/saved-views";
import { resetHouseholdData } from "../lib/server/household-reset";

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

  it("consumes one email link atomically across independent native auth instances", async () => {
    await handle.db.insert(s.authUsers).values({ id: "native-link", name: "Synthetic link", email: "native-link@example.test", emailVerified: true });
    let mail: AuthLinkMail | undefined;
    const options = {
      secret: "synthetic-native-link-session-secret", baseURL: "http://localhost:3112", isVercel: false,
      sendCode: async () => {}, sendLink: async (value: AuthLinkMail) => { mail = value; },
    };
    const instances = [createAuth(handle.db, options), createAuth(handle.db, options)];
    const headers = { origin: options.baseURL, "content-type": "application/json", "x-forwarded-for": "127.0.0.81" };
    const sent = await instances[0]!.handler(new Request(`${options.baseURL}/api/auth/sign-in/magic-link`, {
      method: "POST", headers, body: JSON.stringify({
        email: "native-link@example.test", callbackURL: "/onboarding", newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/sign-in?emailLinkError=1",
      }),
    }));
    expect(sent.status).toBe(200);
    expect(mail).toBeDefined();
    const responses = await Promise.all(instances.map((instance) => instance.handler(new Request(mail!.url, { headers }))));
    expect(responses.filter((response) => response.headers.get("location") === `${options.baseURL}/onboarding`)).toHaveLength(1);
    expect(responses.filter((response) => response.headers.get("location")?.includes("error=INVALID_TOKEN"))).toHaveLength(1);
    expect(responses.filter((response) => response.headers.getSetCookie().length > 0)).toHaveLength(1);
    expect(await handle.db.select().from(s.authSessions)).toHaveLength(1);
    expect(await handle.db.select().from(s.authVerifications)).toEqual([]);
  });

  it("serializes household creation across one account's sessions without adopting legacy rows or blocking independent accounts", async () => {
    await handle.db.insert(s.authUsers).values(["cook", "other"].map((id) => ({
      id, name: "Synthetic", email: `${id}@example.test`, emailVerified: true,
    })));
    const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
    await handle.db.insert(s.authSessions).values([...ids, "other"].map((id) => ({
      id, userId: id === "other" ? "other" : "cook", token: `synthetic-${id}`,
      updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    })));
    const [quarantined] = await handle.db.insert(s.people).values({
      name: "Unclaimed synthetic profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning();
    const results = await Promise.allSettled(ids.map((sessionId) =>
      createSessionHousehold(handle.db, { userId: "cook", sessionId }, "New shared home")));
    const success = results.filter((result) => result.status === "fulfilled");
    expect(success).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);
    for (const result of results) if (result.status === "rejected") expect(result.reason.message).toContain("already has");
    const [household] = await handle.db.select().from(s.households);
    expect(await handle.db.select().from(s.householdMembers)).toMatchObject([
      { householdId: household!.id, userId: "cook", role: "owner", personId: null },
    ]);
    const sessions = await handle.db.select().from(s.authSessions).where(eq(s.authSessions.userId, "cook"));
    expect(sessions.filter((session) => session.activeHouseholdId === household!.id)).toHaveLength(1);
    expect(sessions.filter((session) => session.householdSelectionVersion === 0)).toHaveLength(11);
    const independent = await createSessionHousehold(handle.db, { userId: "other", sessionId: "other" }, "Other home");
    expect(independent.householdId).not.toBe(household!.id);
    expect(await handle.db.select().from(s.households)).toHaveLength(2);
    expect(await handle.db.select().from(s.people)).toEqual([quarantined]);
    expect(await handle.db.select().from(s.householdBootstrap)).toEqual([]);
  });

  it("rolls back operator recipe renames across household human classes on native Postgres", async () => {
    await handle.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    const recipes = await handle.db.insert(s.recipes).values(["old", "new"].map((slug) => ({
      slug, name: slug, kind: "recipe" as const, family: "test", mealSlots: ["dinner"], cuisine: "test",
      isIndian: false, servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, equipment: [], tags: [], fridgeDays: 2,
    }))).returning({ id: s.recipes.id });
    const from = recipes[0]!.id, to = recipes[1]!.id;
    for (const householdId of ["a", "b"]) {
      await writeRecipeFeedback(handle.db, from, { rating: 4 }, householdId);
      await handle.db.insert(s.recipeLinks).values({
        householdId, recipeId: from, uid: randomUUID(), kind: "recipe", url: "https://example.test", title: "Synthetic",
        createdAt: at, updatedAt: at,
      });
    }
    const feedback = await handle.db.select().from(s.recipeFeedback);
    const links = await handle.db.select().from(s.recipeLinks);
    const revisions = await handle.db.select().from(s.syncState);
    await handle.pool.query(`create function fail_rename() returns trigger language plpgsql as $$ begin raise exception 'synthetic rename failure'; end $$;
      create trigger fail_rename before update on recipe_links for each row execute function fail_rename()`);
    try {
      await expect(applyRenames(handle.db, { old: "new" })).rejects.toThrow();
      expect(await handle.db.select().from(s.recipeFeedback)).toEqual(feedback);
      expect(await handle.db.select().from(s.recipeLinks)).toEqual(links);
      expect(await handle.db.select().from(s.syncState)).toEqual(revisions);
    } finally {
      await handle.pool.query("drop trigger fail_rename on recipe_links; drop function fail_rename()");
    }
    expect(await applyRenames(handle.db, { old: "new" })).toEqual({ moved: ["old"] });
    expect(await handle.db.select().from(s.recipeFeedback)).toHaveLength(2);
    expect((await handle.db.select().from(s.recipeFeedback)).every((row) => row.recipeId === to)).toBe(true);
    expect(await applyRenames(handle.db, { old: "new" })).toEqual({ moved: [] });
  });

  it.each(["export", "import"] as const)("holds the household catalogue lock throughout legacy %s class work", async (operation) => {
    const contender = await handle.pool.connect();
    let calls = 0;
    const lockCheck = async () => {
      calls++;
      await expect(contender.query("insert into households (id, name) values ('concurrent', 'Synthetic contender')"))
        .rejects.toMatchObject({ code: "55P03" });
    };
    const originalExport = savedViewsClass.exportFiles, originalImport = savedViewsClass.importFiles;
    const probe = operation === "export"
      ? vi.spyOn(savedViewsClass, "exportFiles").mockImplementation(async (db, scope) => {
        await lockCheck();
        return originalExport(db, scope);
      })
      : vi.spyOn(savedViewsClass, "importFiles").mockImplementation(async (db, files, context) => {
        await lockCheck();
        return originalImport(db, files, context);
      });
    try {
      await contender.query("set lock_timeout = '100ms'");
      if (operation === "export") await exportHumanData(handle.db);
      else await importHumanData(handle.db, { manifest: { version: 2, tables: {} }, files: {} });
      expect(calls).toBe(1);
      await contender.query("insert into households (id, name) values ('concurrent', 'Synthetic contender')");
      expect(await handle.db.select().from(s.households)).toMatchObject([{ id: "concurrent" }]);
    } finally {
      probe.mockRestore();
      await contender.query("reset lock_timeout");
      contender.release();
    }
  });

  it("commits a household reset before removing only its photo bytes on native Postgres", async () => {
    await handle.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    const [profile] = await handle.db.insert(s.people).values({
      householdId: "a", name: "Fixture", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await handle.db.insert(s.authUsers).values({ id: "owner", name: "Fixture", email: "fixture@example.test", emailVerified: true });
    await handle.db.insert(s.householdMembers).values({ userId: "owner", householdId: "a", personId: profile!.id, role: "owner" });
    const access = await resolveHouseholdAccess(handle.db, "owner", "a");
    const store = createMemoryStore();
    const uids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, householdId] of ["a", "b", null].entries()) {
      await handle.db.insert(s.savedViews).values({ householdId, list: "recipes", name: "Fixture", query: "", uid: randomUUID() });
      await handle.db.insert(s.photos).values({ householdId, uid: uids[i]!, ingredientSlug: "fixture", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at });
      for (const key of Object.values(photoKeys(uids[i]!))) await store.put(key, Buffer.from("Synthetic"), "image/webp");
    }
    const originalDelete = store.delete.bind(store);
    const removed: string[] = [];
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      expect(await handle.db.select().from(s.photos).where(eq(s.photos.householdId, "a"))).toEqual([]);
      removed.push(key);
      await originalDelete(key);
    });
    await resetHouseholdData(handle.db, access, "all", store);
    expect(removed.sort()).toEqual(Object.values(photoKeys(uids[0]!)).sort());
    expect(await handle.db.select().from(s.photos)).toHaveLength(2);
    expect(await handle.db.select().from(s.savedViews)).toHaveLength(2);
    expect((await store.list()).sort()).toEqual(uids.slice(1).flatMap((uid) => Object.values(photoKeys(uid))).sort());
    expect(await handle.db.select().from(s.householdMembers)).toMatchObject([{ userId: "owner", personId: null }]);
  });

  it("locks session selection throughout a verified mutation and refuses stale capabilities after switching", async () => {
    await handle.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    await handle.db.insert(s.authUsers).values({ id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true });
    const [person] = await handle.db.insert(s.people).values({
      householdId: "a", name: "Synthetic profile", sex: "other", birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning({ id: s.people.id });
    await handle.db.insert(s.householdMembers).values([
      { householdId: "a", userId: "cook", role: "owner", personId: person!.id },
      { householdId: "b", userId: "cook", role: "member" },
    ]);
    await handle.db.insert(s.authSessions).values({
      id: "session", userId: "cook", token: "synthetic-session", updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const identity = { userId: "cook", sessionId: "session" };
    await selectSessionHousehold(handle.db, identity, "a");
    const access = await resolveSessionHouseholdAccess(handle.db, identity);
    const contender = await handle.pool.connect();
    try {
      await mutateHouseholdState(handle.db, access, async () => {
        for (const statement of [
          "update auth_sessions set active_household_id = 'b', household_selection_version = household_selection_version + 1 where id = 'session'",
          "delete from auth_sessions where id = 'session'",
        ]) {
          await contender.query("begin");
          try {
            await contender.query("set local lock_timeout = '150ms'");
            await expect(contender.query(statement)).rejects.toMatchObject({ code: "55P03" });
          } finally { await contender.query("rollback"); }
        }
      });
      await selectSessionHousehold(handle.db, identity, "b");
      let called = false;
      await expect(mutateHouseholdState(handle.db, access, async () => { called = true; })).rejects.toThrow("session changed");
      expect(called).toBe(false);
      expect(await resolveSessionHouseholdAccess(handle.db, identity)).toMatchObject({
        householdId: "b", personId: null, session: { selectionVersion: 2 },
      });
    } finally { contender.release(); }
  });

  it("permits concurrent memberships in distinct households but rejects duplicate account membership per namespace", async () => {
    await handle.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    await handle.db.insert(s.authUsers).values({ id: "cook", name: "Synthetic cook", email: "cook@example.test", emailVerified: true });
    const writes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => handle.db.insert(s.householdMembers).values({
      householdId: ["a", "b", null][i % 3], userId: "cook", role: "member",
    })));
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(3);
    const rejected = writes.filter((write) => write.status === "rejected");
    expect(rejected).toHaveLength(9);
    for (const write of rejected) expect(write.reason).toMatchObject({ cause: { code: "23505" } });
    expect(await handle.db.select().from(s.householdMembers).orderBy(s.householdMembers.householdId)).toMatchObject([
      { householdId: "a", userId: "cook" }, { householdId: "b", userId: "cook" }, { householdId: null, userId: "cook" },
    ]);
  });

  it("keeps concurrent pantry and prep upserts independent in each household and legacy namespace", async () => {
    await handle.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    const [ingredient] = await handle.db.insert(s.ingredients).values({
      slug: "fixture", name: "Fixture", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0,
      fatG: 0, fibreG: 0, source: "USDA", sourceId: "fixture", aisle: "test", whereToBuy: [],
      isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    }).returning({ id: s.ingredients.id });
    await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const householdId = ["a", "b", null][i % 3];
      return handle.db.transaction(async (tx) => {
        await tx.insert(s.pantry).values({ householdId, ingredientId: ingredient!.id, have: householdId === "a", alwaysStock: false })
          .onConflictDoUpdate({ target: [s.pantry.householdId, s.pantry.ingredientId], set: { have: householdId === "a" } });
        await tx.insert(s.prepTaskState).values({ householdId, date: "2026-11-02", taskKey: "shared-fixture", done: householdId === "b" })
          .onConflictDoUpdate({ target: [s.prepTaskState.householdId, s.prepTaskState.date, s.prepTaskState.taskKey], set: { done: householdId === "b" } });
      });
    }));
    expect(await handle.db.select().from(s.pantry).orderBy(s.pantry.householdId)).toMatchObject([
      { householdId: "a", have: true }, { householdId: "b", have: false }, { householdId: null, have: false },
    ]);
    expect(await handle.db.select().from(s.prepTaskState).orderBy(s.prepTaskState.householdId)).toMatchObject([
      { householdId: "a", done: false }, { householdId: "b", done: true }, { householdId: null, done: false },
    ]);
  });

  it("scopes owned plan writes on native Postgres and serializes membership/verification revocation until commit", async () => {
    await handle.db.insert(s.households).values([{ id: "native-a", name: "Fixture A" }, { id: "native-b", name: "Fixture B" }]);
    const profiles = await handle.db.insert(s.people).values(["native-a", "native-b"].map((householdId) => ({
      householdId, name: "Synthetic profile", sex: "other" as const, birthDate: "2000-01-01",
      heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
    }))).returning({ id: s.people.id });
    await handle.db.insert(s.authUsers).values(["native-a", "native-b"].map((id) => ({
      id, name: "Synthetic account", email: `${id}@example.test`, emailVerified: true,
    })));
    await handle.db.insert(s.householdMembers).values(profiles.map((profile, i) => ({
      householdId: i === 0 ? "native-a" : "native-b", userId: i === 0 ? "native-a" : "native-b",
      personId: profile.id, role: "owner" as const,
    })));
    const a = await resolveHouseholdAccess(handle.db, "native-a", "native-a");
    const b = await resolveHouseholdAccess(handle.db, "native-b", "native-b");
    await expect(changeMemberRole(handle.db, "native-a", "native-b", "member")).rejects.toThrow("no longer in the household");
    await expect(removeHouseholdMember(handle.db, "native-a", "native-b")).rejects.toThrow("no longer in the household");
    await expect(changeMemberRole(handle.db, "native-a", "native-a", "member")).rejects.toThrow("at least one verified owner");
    await expect(handle.db.update(s.householdMembers).set({ householdId: "native-b" }).where(eq(s.householdMembers.userId, "native-a"))).rejects.toThrow();
    await expect(handle.db.insert(s.householdInvitations).values({
      householdId: "native-b", id: "cross-parent", email: "recipient@example.test", tokenHash: "cross-parent",
      invitedByUserId: "native-b", personId: profiles[0]!.id, expiresAt: new Date(Date.now() + 86_400_000),
    })).rejects.toThrow();
    const input = {
      setup: {
        personIds: [profiles[0]!.id], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, maxActiveMin: null, healthFocus: { nutrientDense: true, lowSugar: true, light: true },
        prepStyle: "leftovers" as const, createdAt: at,
      },
      seed: 42, slots: [], routines: [], recipeIds: new Map<string, number>(),
    };
    const contender = await handle.pool.connect();
    try {
      await withTx(handle.db, async (tx) => {
        const id = await persistHouseholdPlan(tx, a, input);
        expect(await householdPlan(tx, a, id)).toMatchObject({ plan: { householdId: "native-a" } });
        for (const statement of [
          "delete from household_members where user_id = 'native-a'",
          "update auth_users set email_verified = false where id = 'native-a'",
        ]) {
          await contender.query("begin");
          try {
            await contender.query("set local lock_timeout = '150ms'");
            await expect(contender.query(statement)).rejects.toMatchObject({ code: "55P03" });
          } finally { await contender.query("rollback"); }
        }
      });
      expect(await householdPlans(handle.db, a)).toHaveLength(1);
      expect(await householdPlans(handle.db, b)).toEqual([]);
      await expect(handle.db.update(s.planSetups).set({ householdId: "native-b" })).rejects.toThrow();
      await expect(handle.db.update(s.plans).set({ householdId: "native-b" })).rejects.toThrow();
      const [owned] = await householdPlans(handle.db, a);
      await expect(mutateHouseholdPlan(handle.db, b, owned!.id, async () => {
        throw new Error("Foreign mutation callback must not run");
      })).rejects.toThrow("not available");
      await mutateHouseholdPlan(handle.db, a, owned!.id, async (tx) => {
        await tx.insert(s.groceryManual).values({ planId: owned!.id, text: "Owned native write", checked: false });
        for (const statement of [
          "delete from household_members where user_id = 'native-a'",
          "update auth_users set email_verified = false where id = 'native-a'",
          `update plans set seed = 999 where id = ${owned!.id}`,
        ]) {
          await contender.query("begin");
          try {
            await contender.query("set local lock_timeout = '150ms'");
            await expect(contender.query(statement)).rejects.toMatchObject({ code: "55P03" });
          } finally { await contender.query("rollback"); }
        }
      });
      expect(await handle.db.select().from(s.groceryManual)).toMatchObject([{ planId: owned!.id, text: "Owned native write" }]);
      await Promise.all(Array.from({ length: 6 }, (_, i) => changeHouseholdDefaultView(handle.db, a, "recipes", `q=native-${i}`)));
      const saved = await handle.db.select().from(s.savedViews);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ householdId: "native-a", isDefault: true });
      await changeHouseholdDefaultView(handle.db, b, "recipes", "q=foreign");
      await changeHouseholdDefaultView(handle.db, a, "recipes", null);
      expect(await defaultViewQuery(handle.db, "recipes", "native-a")).toBeNull();
      expect(await defaultViewQuery(handle.db, "recipes", "native-b")).toBe("q=foreign");
      const [feedbackRecipe] = await handle.db.insert(s.recipes).values({
        slug: "native-feedback", name: "Native feedback fixture", kind: "recipe", family: "test",
        mealSlots: ["dinner"], cuisine: "test", isIndian: false, servings: 1, prepMin: 0, activeMin: 0,
        totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
      }).returning({ id: s.recipes.id });
      await Promise.all(Array.from({ length: 6 }, (_, i) => mutateHouseholdState(handle.db, a, (tx) =>
        writeLink(tx, feedbackRecipe!.id, {
          kind: "recipe", url: `https://example.com/native-${i}`, title: `Native ${i}`,
        }, profiles[0]!.id, a.householdId))));
      expect((await handle.db.select().from(s.recipeLinks)).map((row) => row.position).sort()).toEqual([0, 1, 2, 3, 4, 5]);
      const store = createMemoryStore();
      const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#336699" } }).jpeg().toBuffer();
      const scope: PhotoWriteScope = { householdId: a.householdId, commit: (work) => mutateHouseholdState(handle.db, a, work) };
      await Promise.all(Array.from({ length: 4 }, () => writeUploadedPhoto(handle.db, store, {
        ...scope, subject: { kind: "recipe", recipeId: feedbackRecipe!.id }, bytes, personId: profiles[0]!.id,
      })));
      const photos = await handle.db.select().from(s.photos);
      expect(photos.map((row) => row.position).sort()).toEqual([0, 1, 2, 3]);
      expect(photos.filter((row) => row.isCover)).toHaveLength(1);
      await expect(writeUploadedPhoto(handle.db, store, {
        ...scope, subject: { kind: "recipe", recipeId: feedbackRecipe!.id }, bytes, maxPhotos: 4,
      })).rejects.toThrow("up to 4");
      expect(await store.list()).toHaveLength(8);
      const approvals = await Promise.all(Array.from({ length: 4 }, () => approveCandidate(handle.db, store, {
        ...scope, candidateKey: "commons:native", provider: "commons", subject: { kind: "recipe", recipeId: feedbackRecipe!.id },
        subjectSlug: "native-feedback", credit: { licence: "CC0 1.0" }, bytes,
      })));
      expect(new Set(approvals.map((r) => r.uid)).size).toBe(1);
      expect(await store.list()).toHaveLength(10);
      expect(await handle.db.select().from(s.photoDecisions)).toMatchObject([{ householdId: a.householdId, decision: "approved" }]);
      await approveCandidate(handle.db, store, {
        householdId: b.householdId, commit: (work) => mutateHouseholdState(handle.db, b, work),
        candidateKey: "commons:native", provider: "commons", subject: { kind: "recipe", recipeId: feedbackRecipe!.id },
        subjectSlug: "native-feedback", credit: { licence: "CC0 1.0" }, bytes,
      });
      expect(await handle.db.select().from(s.photoDecisions)).toHaveLength(2);
      await Promise.all([{ favourite: true }, { rating: 5 }, { notes: "First household" }].map((patch) =>
        mutateHouseholdPerson(handle.db, a, profiles[0]!.id, async (tx) => {
          await tx.select().from(s.households).where(eq(s.households.id, a.householdId)).for("update");
          await writePersonalRecipeFeedback(tx, profiles[0]!.id, feedbackRecipe!.id, patch, a.householdId);
        })));
      await mutateHouseholdPerson(handle.db, b, profiles[1]!.id, (tx) =>
        writePersonalRecipeFeedback(tx, profiles[1]!.id, feedbackRecipe!.id, { rating: 1, banned: true }, b.householdId));
      expect(await handle.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, a.householdId)))
        .toMatchObject([{ status: "tested", banned: false, notes: "First household" }]);
      expect(await handle.db.select().from(s.personRecipeFeedback).where(eq(s.personRecipeFeedback.personId, profiles[0]!.id)))
        .toMatchObject([{ favourite: true, rating: 5 }]);
      expect(await handle.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, b.householdId)))
        .toMatchObject([{ status: "tested", banned: true }]);
      await mutateHouseholdPerson(handle.db, a, profiles[0]!.id, async () => {
        for (const statement of [
          "delete from household_members where user_id = 'native-a'",
          "update auth_users set email_verified = false where id = 'native-a'",
          `update people set name = 'Competing profile write' where id = ${profiles[0]!.id}`,
        ]) {
          await contender.query("begin");
          try {
            await contender.query("set local lock_timeout = '150ms'");
            await expect(contender.query(statement)).rejects.toMatchObject({ code: "55P03" });
          } finally { await contender.query("rollback"); }
        }
      });
      await expect(deleteHouseholdPlan(handle.db, b, owned!.id)).rejects.toThrow("not available");
      await expect(regenerateHouseholdPlan(handle.db, b, owned!.id, 7, [], input.recipeIds)).rejects.toThrow("not available");
      await expect(persistHouseholdPlan(handle.db, a, { ...input, setup: { ...input.setup, personIds: [profiles[1]!.id] } })).rejects.toThrow("not in this household");
      await contender.query("delete from household_members where user_id = 'native-a'");
      await expect(persistHouseholdPlan(handle.db, a, input)).rejects.toThrow("not available");
      expect(await handle.db.select().from(s.plans)).toHaveLength(1);
    } finally { contender.release(); }
  });

  it("atomically expands populated legacy household ownership on native Postgres and never replays a successful backfill", async () => {
    const database = `protein_kitchen_household_${randomUUID().replaceAll("-", "")}`;
    const directory = await mkdtemp(path.join(tmpdir(), "pk-native-household-migration-"));
    let created = false;
    let target: ReturnType<typeof openPostgres> | undefined;
    try {
      const migrationsFolder = path.resolve("db/postgres-migrations");
      await cp(migrationsFolder, directory, { recursive: true });
      const journalFile = path.join(directory, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalFile, "utf8")) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx < 10);
      await writeFile(journalFile, JSON.stringify(journal));
      await handle.pool.query(`CREATE DATABASE "${database}"`);
      created = true;
      const connection = new URL(url!); connection.pathname = `/${database}`;
      target = openPostgres({ connectionString: connection.toString(), runtimeEnvironment: "test", databaseEnvironment: "test" });
      await migrate(target.db, { migrationsFolder: directory });
      await target.pool.query(`insert into people (id, name, sex, birth_date, height_cm, weight_kg, activity_level, diet_flags)
        values (300, 'Synthetic legacy household', 'other', '2000-01-01', 170, 70, 'light', '[]')`);
      await target.pool.query(`insert into auth_users (id, name, email, email_verified) values ('legacy-owner', 'Synthetic owner', 'legacy@example.test', true)`);
      await target.pool.query(`insert into household_members (user_id, role, person_id) values ('legacy-owner', 'owner', 300)`);
      await target.pool.query(`insert into plan_setups (id, person_ids, start_date, end_date, meal_types, cuisine_balance, created_at)
        values (400, '[300]', '2026-11-01', '2026-11-07', '["dinner"]', 0.5, $1)`, [at]);
      await target.pool.query(`insert into plans (id, setup_id, seed, created_at) values (500, 400, 42, $1)`, [at]);
      const before = (await target.pool.query("select * from people")).rows[0];
      await target.pool.query(`create function reject_household_backfill() returns trigger language plpgsql as
        $$ begin raise exception 'injected migration failure'; end $$`);
      await target.pool.query(`create trigger reject_household_backfill before update on people for each row execute function reject_household_backfill()`);
      await expect(migrate(target.db, { migrationsFolder })).rejects.toThrow();
      expect((await target.pool.query("select * from people")).rows).toEqual([before]);
      expect((await target.pool.query("select to_regclass('public.households') as household")).rows).toEqual([{ household: null }]);
      await target.pool.query("drop trigger reject_household_backfill on people");
      await target.pool.query("drop function reject_household_backfill()");
      await migrate(target.db, { migrationsFolder });
      const householdId = "00000000-0000-4000-8000-000000000001";
      expect((await target.pool.query("select * from people")).rows).toEqual([{ ...before, household_id: householdId }]);
      expect(await target.db.select().from(s.householdMembers)).toMatchObject([{ userId: "legacy-owner", personId: 300, role: "owner", householdId }]);
      expect(await target.db.select().from(s.plans)).toMatchObject([{ id: 500, seed: 42, householdId }]);
      expect(await target.db.select().from(s.planSetups)).toMatchObject([{ id: 400, personIds: [300], householdId }]);
      const household = await target.db.select().from(s.households);
      await migrate(target.db, { migrationsFolder });
      expect(await target.db.select().from(s.households)).toEqual(household);
      await expect(target.db.delete(s.households)).rejects.toThrow();
    } finally {
      if (target) await target.close();
      if (created) await handle.pool.query(`DROP DATABASE "${database}"`);
      await rm(directory, { recursive: true });
    }
  });

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
    await handle.db.insert(s.households).values({ id: "reminder-household", name: "Synthetic reminder household" });
    await handle.db.insert(s.people).values({
      householdId: "reminder-household",
      id: 1, name: "Synthetic reminder cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: [], reminderTime: "21:00",
    });
    await handle.db.insert(s.authUsers).values({ id: "reminder-user", name: "Synthetic cook", email: "native-reminder@example.test", emailVerified: true });
    await handle.db.insert(s.householdMembers).values({ householdId: "reminder-household", userId: "reminder-user", personId: 1, role: "owner" });
    await handle.db.insert(s.authSessions).values({
      id: "reminder-session", userId: "reminder-user", token: "native-synthetic-reminder-session",
      expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(),
    });
    await handle.db.insert(s.pushSubscriptions).values({
      id: 1, personId: 1, endpoint: "https://push.example.test/native", p256dh: "synthetic", auth: "synthetic", createdAt: at,
    });
    const input = { personId: 1, householdId: "reminder-household", householdTimezone: "UTC", payload: { title: "Synthetic", body: "Synthetic", url: "/" }, now: new Date("2099-11-01T21:00:00Z") };
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
        await handle.db.insert(s.authVerifications).values({
          id, identifier: `magic-link:synthetic-${id}`,
          value: JSON.stringify({ type: "magic-link", email: `${id}@example.test`.toUpperCase() }),
          expiresAt: new Date(Date.now() + 60_000),
        });
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
    if (operation.startsWith("delete")) {
      const users = await handle.db.select({ id: s.authUsers.id }).from(s.authUsers);
      const pendingLinks = await handle.db.select({ id: s.authVerifications.id }).from(s.authVerifications);
      expect(pendingLinks.map((row) => row.id).sort()).toEqual(users.map((row) => row.id).sort());
    }
  });

  it.each(["accept", "revoke"])("serializes email association acceptance against concurrent %s on native Postgres", async (operation) => {
    await handle.db.insert(s.authUsers).values(["owner", "recipient"].map((id) => ({
      id, name: "Synthetic association cook", email: `${id}@example.test`, emailVerified: true,
    })));
    await handle.db.insert(s.households).values([
      { id: "target", name: "Target household" }, { id: "existing", name: "Existing household" },
    ]);
    await handle.db.insert(s.householdMembers).values([
      { householdId: "target", userId: "owner", role: "owner" },
      { householdId: "existing", userId: "recipient", role: "owner" },
    ]);
    const identity = { userId: "recipient", sessionId: "recipient-session" };
    await handle.db.insert(s.authSessions).values({
      id: identity.sessionId, userId: identity.userId, token: "synthetic-association-session",
      activeHouseholdId: "existing", expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
    });
    const association = await addEmailAssociation(handle.db, "owner", { email: "recipient@example.test" });
    const results = await Promise.allSettled([
      acceptEmailAssociation(handle.db, identity, association.id),
      operation === "accept"
        ? acceptEmailAssociation(handle.db, identity, association.id)
        : revokeInvitation(handle.db, "owner", association.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [row] = await handle.db.select().from(s.householdInvitations).where(eq(s.householdInvitations.id, association.id));
    expect(Boolean(row!.acceptedAt)).not.toBe(Boolean(row!.revokedAt));
    const members = await handle.db.select().from(s.householdMembers).where(eq(s.householdMembers.userId, "recipient"));
    expect(members.filter((member) => member.householdId === "target")).toHaveLength(row!.acceptedAt ? 1 : 0);
    expect(members.find((member) => member.householdId === "existing")).toMatchObject({ role: "owner" });
    expect(await handle.db.select().from(s.authSessions).where(eq(s.authSessions.id, identity.sessionId)))
      .toMatchObject([{ activeHouseholdId: "existing", householdSelectionVersion: 0 }]);
  });

  it("atomically consumes one invitation and reserves each meal profile for one account", async () => {
    await handle.db.insert(s.authUsers).values(["owner", "cook"].map((id) => ({
      id, name: "Synthetic concurrent cook", email: `${id}@example.test`, emailVerified: true,
    })));
    const secret = "synthetic-bootstrap-concurrency-secret";
    const owner = await claimHousehold(handle.db, "owner", secret, secret);
    const [person] = await handle.db.insert(s.people).values({
      householdId: owner.householdId,
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

  it("atomically enforces the shared email-code limit across concurrent auth instances", async () => {
    const sent: string[] = [];
    const options = {
      secret: "synthetic-native-auth-session-secret",
      baseURL: "http://localhost:3112", isVercel: false,
      sendCode: async (mail: { email: string }) => { sent.push(mail.email); }, sendLink: async () => {},
    };
    const instances = [createAuth(handle.db, options), createAuth(handle.db, options)];
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => instances[index % 2]!.handler(new Request(
      "http://localhost:3112/api/auth/email-otp/send-verification-otp", {
        method: "POST", headers: {
          origin: "http://localhost:3112", "content-type": "application/json", "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ email: `${index}@example.test`, type: "sign-in" }),
      },
    ))));
    // The rule allows 5 per minute per address; the shared database counter must admit exactly 5 of 8.
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect(sent).toHaveLength(5);
    expect(await handle.db.select().from(s.authRateLimits)).toMatchObject([{ count: 5 }]);
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
      let artifact = path.join(outputRoot, name!);
      const index = JSON.parse(await readFile(path.join(artifact, "index.json"), "utf8"));
      expect(JSON.stringify(index)).not.toMatch(/PRIVATE_|photos\/|AGE-SECRET/);
      const vault = githubFixture();
      vault.reset();
      await vault.start();
      try {
        const open = () => openPrivateStateRepository(syncConfig, vault.fetch, () => fixtureTime);
        const published = await publishEncryptedVault(artifact, true, open);
        expect(published).toEqual({ id: index.id, changed: true, commit: vault.head });
        expect(await publishEncryptedVault(artifact, true, open)).toEqual({ ...published, changed: false });
        const entries = vault.trees.get(vault.commits.get(vault.head)!.tree.sha)!;
        expect(entries.filter((entry) => entry.path.startsWith(`protein-kitchen/vault/${index.id}/`))).toHaveLength(index.files.length + 1);
        expect(JSON.stringify(vault.requests)).not.toMatch(/PRIVATE_|AGE-SECRET/);
        const downloads = path.join(folder, "downloads");
        await mkdir(downloads, { mode: 0o700 });
        const downloaded = await fetchEncryptedVault(index.id, published.commit, downloads, open);
        expect(downloaded.directory).not.toBe(artifact);
        for (const item of index.files) {
          expect(await readFile(path.join(downloaded.directory, item.file))).toEqual(await readFile(path.join(artifact, item.file)));
        }
        artifact = downloaded.directory;
      } finally { await vault.close(); }
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
