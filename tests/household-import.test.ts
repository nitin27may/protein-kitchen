import { getTableName } from "drizzle-orm";
import { expect, it } from "vitest";
import * as s from "../lib/db/schema";
import { bindImportedHousehold } from "../lib/human/household-migration";
import { restoreSqliteSnapshot } from "../lib/human/sqlite-restore";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { openDb } from "./helpers/db";
import { createSqliteSource } from "./helpers/sqlite-source";

const legacyHouseholdId = "00000000-0000-4000-8000-000000000001";

it("binds all imported ownership roots without changing source digests, human fields or global content", async () => {
  const source = createSqliteSource();
  try {
    const handle = await openDb();
    const snapshot = readSqliteSnapshot(source.file);
    expect(await restoreSqliteSnapshot(handle.db, snapshot)).toEqual(snapshot.tables);
    expect(await handle.db.select().from(s.households)).toMatchObject([{ id: legacyHouseholdId, name: "Existing household" }]);
    for (const table of [s.people, s.pantry, s.planSetups, s.plans, s.prepTaskState, s.recipeFeedback, s.recipeLinks, s.savedViews, s.photos, s.photoDecisions, s.syncState]) {
      const rows = await handle.db.select({ householdId: table.householdId }).from(table);
      expect(rows.length, getTableName(table)).toBeGreaterThan(0);
      expect(rows.every((row) => row.householdId === legacyHouseholdId), getTableName(table)).toBe(true);
    }
    expect(await handle.db.select().from(s.recipeFeedback)).toMatchObject([{
      rating: 4, favourite: true, notes: "Synthetic human note", uid: "feedback-fixture",
      createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z",
    }]);
    expect(await handle.db.select().from(s.householdMembers)).toEqual([]);
    expect(await handle.db.select().from(s.authUsers)).toEqual([]);
  } finally { source.close(); }
});

it("does not invent a household for an empty target or identity-only account", async () => {
  const handle = await openDb();
  expect(await bindImportedHousehold(handle.db)).toBeNull();
  await handle.db.insert(s.authUsers).values({ id: "unassociated", name: "Synthetic account", email: "unassociated@example.test", emailVerified: true });
  expect(await bindImportedHousehold(handle.db)).toBeNull();
  expect(await handle.db.select().from(s.households)).toEqual([]);
});

it("refuses merging or reassigning when any household already exists", async () => {
  const handle = await openDb();
  await handle.db.insert(s.households).values({ id: "other-household", name: "Other household" });
  await handle.db.insert(s.people).values({
    householdId: "other-household", name: "Synthetic cook", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  });
  const before = await handle.db.select().from(s.people);
  await expect(bindImportedHousehold(handle.db)).rejects.toThrow("unclaimed destination");
  expect(await handle.db.select().from(s.people)).toEqual(before);
  expect(await handle.db.select().from(s.households)).toMatchObject([{ id: "other-household" }]);
});

it("rolls the import, identity restarts and new household back together after an ownership write failure", async () => {
  const source = createSqliteSource();
  try {
    const handle = await openDb();
    await handle.failWrite("people", "UPDATE", "reject_import_ownership");
    await expect(restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file))).rejects.toThrow();
    for (const table of [s.households, s.people, s.recipes, s.plans, s.recipeFeedback, s.photos, s.syncState]) {
      expect(await handle.db.select().from(table), getTableName(table)).toEqual([]);
    }
    await handle.dropFailure("people", "reject_import_ownership");
    await restoreSqliteSnapshot(handle.db, readSqliteSnapshot(source.file));
    expect(await handle.db.select().from(s.people)).toMatchObject([{ id: 300, householdId: legacyHouseholdId }]);
  } finally { source.close(); }
});
