import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { exportHumanData, importHumanData, writeRecipeFeedback, writeSavedView } from "../lib/human";
import { markChanged, markExported } from "../lib/human/util";
import { savedViewsClass } from "../lib/human/saved-views";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { writePersonRoutine } from "../lib/human/routines";
import { acknowledgeStateSnapshot, captureStateSnapshot, readStateSyncStatus, STATE_SYNC_CLASSES } from "../lib/sync/snapshot";
import { resolveHouseholdAccess } from "../lib/auth/household-access";

let h: DbHandle;
const at = "2026-10-24T12:00:00.000Z";
beforeEach(async () => { h = await openDb(); });
afterEach(() => vi.restoreAllMocks());

async function addRecipe() {
  const [row] = await h.db.insert(s.recipes).values({
    slug: "synthetic-bowl", name: "Synthetic bowl", kind: "recipe", family: "bowls", mealSlots: ["lunch"],
    cuisine: "global", isIndian: false, servings: 1, prepMin: 1, activeMin: 1, totalMin: 1, equipment: [], tags: [], fridgeDays: 2,
  }).returning();
  return row!.id;
}

describe("explicit shared-state export boundary", () => {
  it.each([[], ["saved-views", "saved-views"], ["unknown"], ["personal-recipe-feedback"], ["person-routines"], ["saved-views", "people"]].map((names) => ({ names })))(
    "refuses empty, duplicate, unknown and unapproved selections before touching the database: $names", async ({ names }) => {
      const transaction = vi.spyOn(h.db, "transaction");
      await expect(captureStateSnapshot(h.db, names)).rejects.toThrow("explicit");
      await expect(readStateSyncStatus(h.db, names)).rejects.toThrow("explicit");
      const receipt = names.length && new Set(names).size === names.length ? Object.fromEntries(names.map((name) => [name, 1])) : {};
      await expect(acknowledgeStateSnapshot(h.db, receipt)).rejects.toThrow("explicit");
      expect(transaction).not.toHaveBeenCalled();
      expect(await h.db.select().from(s.syncState)).toEqual([]);
    },
  );

  it("exports only explicitly selected classes, excluding identity, profiles, routines and personal feedback", async () => {
    const recipeId = await addRecipe();
    const [person] = await h.db.insert(s.people).values({
      name: "PRIVATE_PROFILE_SENTINEL", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
    }).returning();
    await h.db.insert(s.authUsers).values({ id: "private-account", name: "PRIVATE_ACCOUNT_SENTINEL", email: "private@example.test" });
    const [habit] = await h.db.insert(s.habits).values({
      slug: "PRIVATE_ROUTINE_SENTINEL", title: "Synthetic", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false,
    }).returning();
    await writePersonalRecipeFeedback(h.db, person!.id, recipeId, { rating: 5 });
    await writePersonRoutine(h.db, person!.id, habit!.id, { active: true, days: [1], timeOfDay: "morning", servings: 1 });
    await writeRecipeFeedback(h.db, recipeId, { notes: "Synthetic shared cooking note" });
    await writeSavedView(h.db, { list: "recipes", query: "quick=1" });
    const snapshot = await captureStateSnapshot(h.db, ["saved-views", "recipe-feedback"]);
    expect(Object.keys(snapshot.bundle.manifest.tables)).toEqual(["recipe-feedback", "saved-views"]);
    expect(Object.keys(snapshot.revisions)).toEqual(["recipe-feedback", "saved-views"]);
    expect(Object.keys(snapshot.bundle.files).every((file) => file.startsWith("feedback/") || file.startsWith("saved-views/"))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|private@example|personal-feedback\/|routines\//);
    expect(await exportHumanData(h.db)).toMatchObject({ manifest: { tables: { "personal-recipe-feedback": { count: 1 }, "person-routines": { count: 1 } } } });
  });

  it("preserves full export/import round trips and byte-stable selected exports", async () => {
    await writeRecipeFeedback(h.db, await addRecipe(), { notes: "Synthetic" });
    await writeSavedView(h.db, { list: "recipes", query: "quick=1" });
    const first = await captureStateSnapshot(h.db, [...STATE_SYNC_CLASSES].reverse());
    expect(await captureStateSnapshot(h.db, STATE_SYNC_CLASSES)).toEqual(first);
    const full = await exportHumanData(h.db);
    const other = await openDb();
    const [recipe] = await h.db.select().from(s.recipes);
    await other.db.insert(s.recipes).values({ ...recipe!, id: 99 });
    expect((await importHumanData(other.db, full)).skipped).toEqual([]);
    expect(await exportHumanData(other.db)).toEqual(full);
  });

  it("includes empty classes so an eventual remote sync can represent deletions", async () => {
    const snapshot = await captureStateSnapshot(h.db, STATE_SYNC_CLASSES);
    expect(snapshot.bundle.files).toEqual({});
    expect(Object.values(snapshot.bundle.manifest.tables).every((entry) => entry.count === 0)).toBe(true);
    expect(Object.values(snapshot.revisions)).toEqual([1, 1, 1, 1, 1]);
  });

  it("rejects generic exporter selection errors before stamping legacy data", async () => {
    await h.db.insert(s.savedViews).values({ list: "recipes", name: "Synthetic", query: "" });
    for (const names of [[], ["saved-views", "saved-views"], ["saved-views", "unknown"]]) {
      await expect(exportHumanData(h.db, names)).rejects.toThrow();
    }
    expect(await h.db.select().from(s.savedViews)).toMatchObject([{ uid: null, createdAt: null, updatedAt: null }]);
  });

  it("stamps a legacy selected row once and captures an unchanged receipt on repeat", async () => {
    await h.db.insert(s.savedViews).values({ list: "recipes", name: "Synthetic", query: "" });
    const first = await captureStateSnapshot(h.db, ["saved-views"]);
    expect(await captureStateSnapshot(h.db, ["saved-views"])).toEqual(first);
    expect(await h.db.select().from(s.savedViews)).toMatchObject([{ uid: expect.any(String), createdAt: expect.any(String) }]);
  });

  it.each(["../bad", "./bad", ".git/config", "double//bad", "bad\\path", "bad name", "bad\npath"])(
    "rolls back legacy stamping and marker initialization for unsafe paths: %s", async (list) => {
      await h.db.insert(s.savedViews).values({ list, name: "Synthetic", query: "" });
      await expect(captureStateSnapshot(h.db, ["saved-views"])).rejects.toThrow("unsafe export path");
      expect(await h.db.select().from(s.savedViews)).toMatchObject([{ uid: null, createdAt: null, updatedAt: null }]);
      expect(await h.db.select().from(s.syncState)).toEqual([]);
    },
  );

  it("rejects an exporter that writes outside its registered prefix", async () => {
    vi.spyOn(savedViewsClass, "exportFiles").mockResolvedValueOnce({ "outside.json": "{}" });
    await expect(captureStateSnapshot(h.db, ["saved-views"])).rejects.toThrow("outside its folder");
    expect(await h.db.select().from(s.syncState)).toEqual([]);
  });

  it("sorts explicit class selections and file paths deterministically", async () => {
    vi.spyOn(savedViewsClass, "exportFiles").mockResolvedValueOnce({ "saved-views/z.json": "z", "saved-views/a.json": "a" });
    const bundle = await exportHumanData(h.db, ["saved-views", "photo-decisions"]);
    expect(Object.keys(bundle.manifest.tables)).toEqual(["photo-decisions", "saved-views"]);
    expect(Object.keys(bundle.files)).toEqual(["saved-views/a.json", "saved-views/z.json"]);
  });

  it("rolls back all class initialization when a later marker insert fails", async () => {
    await h.failWrite("sync_state", "insert", "fail_capture", "NEW.data_class = 'saved-views'");
    await expect(captureStateSnapshot(h.db, ["photo-decisions", "saved-views"])).rejects.toThrow();
    expect(await h.db.select().from(s.syncState)).toEqual([]);
  });
});

describe("revision-based acknowledgement", () => {
  it("requires matching current owner access and a completed profile for interactive snapshots", async () => {
    await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    await h.db.insert(s.people).values({ id: 1, householdId: "a", name: "Fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] });
    await h.db.insert(s.authUsers).values({ id: "owner", name: "Fixture", email: "fixture@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "owner", personId: 1, role: "member" });
    const member = await resolveHouseholdAccess(h.db, "owner", "a");
    await expect(captureStateSnapshot(h.db, ["saved-views"], "a", member)).rejects.toThrow("owner access");
    await h.db.update(s.householdMembers).set({ role: "owner" });
    const owner = await resolveHouseholdAccess(h.db, "owner", "a");
    await expect(captureStateSnapshot(h.db, ["saved-views"], "b", owner)).rejects.toThrow("owner access");
    expect(await h.db.select().from(s.syncState)).toEqual([]);
    expect(await captureStateSnapshot(h.db, ["saved-views"], "a", owner)).toMatchObject({ revisions: { "saved-views": 1 } });
    await h.db.update(s.householdMembers).set({ personId: null });
    const incomplete = await resolveHouseholdAccess(h.db, "owner", "a");
    await expect(captureStateSnapshot(h.db, ["saved-views"], "a", incomplete)).rejects.toThrow("Finish your household profile");
    await expect(captureStateSnapshot(h.db, ["saved-views"], "a", owner)).rejects.toThrow("access changed");
  });

  it("keeps household snapshots, revisions and acknowledgements independent from foreign and legacy namespaces", async () => {
    await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
    for (const householdId of ["a", "b", undefined]) {
      await writeSavedView(h.db, { householdId, list: "recipes", query: `fixture-${householdId}` });
    }
    const a = await captureStateSnapshot(h.db, ["saved-views"], "a");
    const b = await captureStateSnapshot(h.db, ["saved-views"], "b");
    const legacy = await captureStateSnapshot(h.db, ["saved-views"]);
    expect(a.revisions).toEqual({ "saved-views": 1 });
    expect(b.revisions).toEqual(a.revisions);
    for (const [snapshot, value] of [[a, "fixture-a"], [b, "fixture-b"], [legacy, "fixture-undefined"]] as const) {
      expect(Object.keys(snapshot.bundle.files)).toHaveLength(1);
      expect(JSON.parse(Object.values(snapshot.bundle.files)[0]!).query).toBe(value);
    }
    await writeSavedView(h.db, { householdId: "a", list: "recipes", query: "newer-a" });
    expect(await acknowledgeStateSnapshot(h.db, a.revisions, "a")).toEqual([]);
    expect(await acknowledgeStateSnapshot(h.db, b.revisions, "b")).toEqual(["saved-views"]);
    expect(await readStateSyncStatus(h.db, ["saved-views"], "a")).toMatchObject([{ revision: 2, exportedRevision: 0, pending: true }]);
    expect(await readStateSyncStatus(h.db, ["saved-views"], "b")).toMatchObject([{ revision: 1, exportedRevision: 1, pending: false }]);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toMatchObject([{ revision: 1, exportedRevision: 0, pending: true }]);
    await acknowledgeStateSnapshot(h.db, legacy.revisions);
    expect(await readStateSyncStatus(h.db, ["saved-views"], "a")).toMatchObject([{ pending: true }]);
    await markExported(h.db, ["saved-views"]);
    expect(await readStateSyncStatus(h.db, ["saved-views"], "a")).toMatchObject([{ exportedRevision: 0 }]);
    await h.failWrite("sync_state", "update", "fail_owned_revision", "NEW.household_id = 'a'");
    await expect(writeSavedView(h.db, { householdId: "a", list: "recipes", query: "must roll back" })).rejects.toThrow();
    expect(await captureStateSnapshot(h.db, ["saved-views"], "a")).toMatchObject({ revisions: { "saved-views": 2 } });
    expect((await h.db.select().from(s.savedViews).where(eq(s.savedViews.householdId, "a")))[0]!.query).toBe("newer-a");
  });

  it("starts pending, acknowledges once and leaves ordinary local exports independent", async () => {
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toEqual([
      { dataClass: "saved-views", revision: 0, exportedRevision: 0, changedAt: null, pending: true },
    ]);
    await markExported(h.db, ["saved-views"], at);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toMatchObject([{ pending: true }]);
    const snapshot = await captureStateSnapshot(h.db, ["saved-views"]);
    expect(await acknowledgeStateSnapshot(h.db, snapshot.revisions)).toEqual(["saved-views"]);
    const accepted = await readStateSyncStatus(h.db, ["saved-views"]);
    expect(accepted).toMatchObject([{ revision: 1, exportedRevision: 1, pending: false }]);
    expect(await acknowledgeStateSnapshot(h.db, snapshot.revisions)).toEqual([]);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toEqual(accepted);
  });

  it("keeps same-millisecond edits and old out-of-order receipts pending", async () => {
    await h.db.transaction((tx) => markChanged(tx, "saved-views", at));
    const first = await captureStateSnapshot(h.db, ["saved-views"]);
    await h.db.transaction((tx) => markChanged(tx, "saved-views", at));
    expect(await acknowledgeStateSnapshot(h.db, first.revisions)).toEqual([]);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toMatchObject([{ revision: 2, exportedRevision: 0, changedAt: at, pending: true }]);
    const second = await captureStateSnapshot(h.db, ["saved-views"]);
    await acknowledgeStateSnapshot(h.db, second.revisions);
    const accepted = await readStateSyncStatus(h.db, ["saved-views"]);
    expect(await acknowledgeStateSnapshot(h.db, first.revisions)).toEqual([]);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toEqual(accepted);
    await h.db.transaction((tx) => markChanged(tx, "saved-views", at));
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toMatchObject([{ revision: 3, exportedRevision: 2, pending: true }]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid receipt revision %s before writes", async (revision) => {
    await expect(acknowledgeStateSnapshot(h.db, { "saved-views": revision })).rejects.toThrow("positive integer");
    expect(await h.db.select().from(s.syncState)).toEqual([]);
  });

  it("never creates missing markers or accepts future revision receipts", async () => {
    expect(await acknowledgeStateSnapshot(h.db, { "saved-views": 1 })).toEqual([]);
    await captureStateSnapshot(h.db, ["saved-views"]);
    expect(await acknowledgeStateSnapshot(h.db, { "saved-views": 2 })).toEqual([]);
    expect(await readStateSyncStatus(h.db, ["saved-views"])).toMatchObject([{ pending: true, exportedRevision: 0 }]);
  });

  it("rolls back every acknowledgement if a later class update fails", async () => {
    const snapshot = await captureStateSnapshot(h.db, ["saved-views", "photo-decisions"]);
    const before = await h.db.select().from(s.syncState).orderBy(s.syncState.dataClass);
    await h.failWrite("sync_state", "update", "fail_ack", "NEW.data_class = 'saved-views'");
    await expect(acknowledgeStateSnapshot(h.db, snapshot.revisions)).rejects.toThrow();
    expect(await h.db.select().from(s.syncState).orderBy(s.syncState.dataClass)).toEqual(before);
    await h.dropFailure("sync_state", "fail_ack");
    expect(await acknowledgeStateSnapshot(h.db, snapshot.revisions)).toEqual(["photo-decisions", "saved-views"]);
  });

  it("preserves data and its revision when the human write transaction fails", async () => {
    await writeSavedView(h.db, { list: "recipes", query: "original" });
    await h.failWrite("sync_state", "update", "fail_revision");
    await expect(writeSavedView(h.db, { list: "recipes", query: "changed" })).rejects.toThrow();
    expect(await h.db.select().from(s.savedViews)).toMatchObject([{ query: "original" }]);
    expect(await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, "saved-views"))).toMatchObject([{ revision: 1, exportedRevision: 0 }]);
  });
});
