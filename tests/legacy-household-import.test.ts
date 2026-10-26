import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../lib/db/schema";
import { readSqliteSnapshot } from "../lib/db/sqlite-snapshot";
import { resolveHouseholdAccess } from "../lib/auth/household-access";
import { HouseholdAccessError } from "../lib/auth/household";
import { importLegacyBundle, legacyImportEnabled, LegacyImportError } from "../lib/human/legacy-household-import";
import { personKey } from "../lib/human/routines";
import { stableJson } from "../lib/human/util";
import { buildLegacyBundle, dataChecksum, derivedUid, LegacyBundleError, MAX_BUNDLE_BYTES, parseLegacyBundle } from "../lib/legacy/bundle";
import { openDb, type DbHandle } from "./helpers/db";
import { createLegacySource } from "./helpers/legacy-source";
import { seedLegacyTarget } from "./helpers/legacy-target";

const on = { LEGACY_IMPORT_ENABLED: "true" };
const renames = { "old-name": "new-name" };
const now = () => new Date("2026-10-25T00:00:00.000Z");
const at = "2026-11-02T00:00:00.000Z";

let h: DbHandle;
let source: ReturnType<typeof createLegacySource>;
beforeEach(async () => {
  source = createLegacySource();
  h = await openDb();
  await seedLegacyTarget(h);
});
afterEach(() => source.close());

const bundleText = (withPlans = false, over: Partial<Parameters<typeof buildLegacyBundle>[1]> = {}) =>
  stableJson(buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans, renames, now, ...over }));
const accessOf = (userId: string, householdId = "mine") => resolveHouseholdAccess(h.db, userId, householdId);
const run = async (text: string, commit = true, userId = "owner", extra: { linkPerson?: string | null; env?: Record<string, string> } = {}) =>
  importLegacyBundle(h.db, await accessOf(userId), text, { commit, env: on, renames, ...extra });

/** Everything the neighbours own plus all of sync_state: an import must leave this byte-identical. */
async function outside() {
  const scoped = [s.people, s.pantry, s.recipeFeedback, s.recipeLinks, s.savedViews, s.planSetups, s.plans, s.prepTaskState] as const;
  const result: Record<string, unknown[]> = {};
  for (const table of scoped) {
    result[getTableName(table)] = (await h.db.select().from(table)).filter((r) => r.householdId !== "mine");
  }
  result.habit_log = (await h.db.select().from(s.habitLog)).filter((r) => [3, 4].includes(r.personId));
  result.sync_state = await h.db.select().from(s.syncState);
  return JSON.stringify(result);
}

describe("bundle", () => {
  it("is keyed by slug, uid and person key, never by database id, and leaves the excluded classes out", () => {
    const bundle = buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans: true, renames, now });
    const text = stableJson(bundle);
    expect(text).not.toMatch(/"(?:id|person_id|recipe_id|ingredient_id|habit_id|plan_id|setup_id|household_id)"/);
    expect(Object.keys(bundle.source).sort()).not.toEqual(expect.arrayContaining(["photos", "sync_state", "push_subscriptions", "reminder_log", "photo_decisions"]));
    expect(text).not.toContain("example.invalid/push");
    expect(text).not.toContain("photo-fixture");
    expect(bundle.data.people.map((p) => p.key)).toEqual([...bundle.data.people.map((p) => p.key)].sort());
    expect(bundle.data.people.find((p) => p.name === "Second synthetic cook")!.key).toBe(personKey("Second synthetic cook", "1990-05-05"));
    expect(bundle.manifest.counts).toMatchObject({ people: 2, preferences: 4, recipe_feedback: 3, person_routines: 1, pantry: 2, plans: 1, plan_slots: 3 });
    expect(bundle.manifest.sha256).toBe(dataChecksum(bundle.data));
  });

  it("applies data/renames.json, gives uid-less rows a stable derived uid and ignores untouched feedback", () => {
    const first = buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans: false, renames, now });
    expect(first.data.recipe_feedback.map((r) => r.recipe).sort()).toEqual(["fixture", "gone-recipe", "new-name"]);
    expect(first.data.recipe_feedback.find((r) => r.recipe === "new-name")).toMatchObject({ uid: derivedUid("feedback", "new-name"), created_at: "2026-10-23T12:00:00.000Z" });
    expect(first.data.saved_views.find((v) => v.name === "No uid")!.uid).toBe(derivedUid("view", "ingredients|No uid|x=1"));
    const second = buildLegacyBundle(readSqliteSnapshot(source.file), { withPlans: false, renames, now });
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
    expect(first.data.plans).toEqual([]);
  });

  it("refuses two people that share a key and rows that point outside the source", () => {
    const snapshot = readSqliteSnapshot(source.file);
    const twin = structuredClone(snapshot);
    twin.rows.people!.push({ ...twin.rows.people![1]!, id: 302 });
    expect(() => buildLegacyBundle(twin, { withPlans: false, renames, now })).toThrow("cannot be told apart");
    const orphan = structuredClone(snapshot);
    orphan.rows.habit_log![0]!.person_id = 9999;
    expect(() => buildLegacyBundle(orphan, { withPlans: false, renames, now })).toThrow("not in the source people table");
    const noRecipe = structuredClone(snapshot);
    noRecipe.rows.recipe_links![0]!.recipe_id = 9999;
    expect(() => buildLegacyBundle(noRecipe, { withPlans: false, renames, now })).toThrow("not in the source library tables");
    const noSetup = structuredClone(snapshot);
    noSetup.rows.plans![0]!.setup_id = 9999;
    expect(() => buildLegacyBundle(noSetup, { withPlans: true, renames, now })).toThrow("setup that is not in the source");
  });

  it("verifies size, format, version, shape, checksum and counts without echoing content", () => {
    const good = JSON.parse(bundleText(true));
    expect(parseLegacyBundle(JSON.stringify(good)).manifest.counts.people).toBe(2);
    const bad = (mutate: (b: Record<string, any>) => void, message: string) => {
      const copy = structuredClone(good); mutate(copy);
      expect(() => parseLegacyBundle(JSON.stringify(copy))).toThrow(message);
    };
    expect(() => parseLegacyBundle("x".repeat(MAX_BUNDLE_BYTES + 1))).toThrow("too large");
    expect(() => parseLegacyBundle("not json")).toThrow("not a legacy bundle");
    expect(() => parseLegacyBundle("[]")).toThrow("not a legacy bundle");
    expect(() => parseLegacyBundle(JSON.stringify({ format: "other" }))).toThrow("not a legacy bundle");
    bad((b) => { b.version = 2; }, "version is not supported");
    bad((b) => { delete b.data.people; }, "malformed");
    bad((b) => { b.data.people[0].name = "Tampered"; }, "checksum does not match");
    bad((b) => { b.manifest.counts.people = 99; }, "counts do not match");
    try { parseLegacyBundle(JSON.stringify({ ...good, data: { ...good.data, people: [{ secret: "Synthetic leaked value" }] } })); }
    catch (error) { expect(error).toBeInstanceOf(LegacyBundleError); expect(String(error)).not.toContain("Synthetic leaked value"); }
  });
});

describe("import into the caller's own household", () => {
  it("fills the household, remaps ids, keeps uids and never touches the neighbours or sync_state", async () => {
    const before = await outside();
    const report = await run(bundleText(false));
    expect(report).toMatchObject({ dryRun: false, linkedPerson: false });
    expect(report.imported).toMatchObject({ people: 2, preferences: 3, recipe_feedback: 2, recipe_links: 1, saved_views: 2, person_routines: 1, pantry: 1, habit_log: 1 });
    // Unknown slugs are skipped and reported, never failed silently.
    expect(report.skipped).toMatchObject({ preferences: 1, recipe_feedback: 1, pantry: 1, habit_log: 1 });
    expect(report.unknown).toEqual({ recipes: ["gone-recipe"], ingredients: ["gone-ingredient"], habits: ["gone-habit"] });
    expect(await outside()).toBe(before);

    const mine = await h.db.select().from(s.people);
    expect(mine.filter((p) => p.householdId === "mine").map((p) => p.name).sort()).toEqual(["Member profile", "Second synthetic cook", "Starter profile", "Synthetic import fixture"]);
    const feedback = (await h.db.select().from(s.recipeFeedback)).filter((r) => r.householdId === "mine");
    expect(feedback.map((r) => r.uid).sort()).toEqual(["feedback-fixture", derivedUid("feedback", "new-name")].sort());
    expect(feedback.find((r) => r.uid === "feedback-fixture")).toMatchObject({ rating: 4, favourite: true, notes: "Synthetic human note", recipeId: 1 });
    // The renamed recipe's feedback lands on the new slug.
    expect(feedback.find((r) => r.recipeId === 2)).toMatchObject({ rating: 5, notes: "Renamed recipe note" });
    // created_by follows the person remap, not the old id 300.
    const importedPerson = mine.find((p) => p.name === "Synthetic import fixture")!;
    expect(feedback.find((r) => r.uid === "feedback-fixture")!.createdByPersonId).toBe(importedPerson.id);
    expect(importedPerson.id).not.toBe(300);
    const routine = (await h.db.select().from(s.personRoutines))[0]!;
    expect(routine).toMatchObject({ personId: importedPerson.id, uid: "routine-fixture", days: [1, 3, 5] });
    expect((await h.db.select().from(s.pantry)).filter((r) => r.householdId === "mine")).toHaveLength(1);
    // Nothing is marked changed: the neighbours' sync_state rows are the only ones.
    expect((await h.db.select().from(s.syncState)).every((r) => r.householdId !== "mine")).toBe(true);
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("maps plan setups' person_ids, plans, portions, prep keys and part choices when plans are included", async () => {
    const report = await run(bundleText(true));
    expect(report.imported).toMatchObject({ plan_setups: 1, plans: 1, plan_slots: 2, plan_slot_portions: 3, plan_routines: 1, grocery_state: 1, grocery_manual: 1, plan_part_state: 2, plan_progress: 1, prep_task_state: 1 });
    expect(report.skipped).toMatchObject({ plan_slots: 1 });
    const people = (await h.db.select().from(s.people)).filter((p) => p.householdId === "mine");
    const ids = people.filter((p) => ["Synthetic import fixture", "Second synthetic cook"].includes(p.name)).map((p) => p.id).sort((a, b) => a - b);
    const [setup] = await h.db.select().from(s.planSetups);
    expect(setup).toMatchObject({ householdId: "mine" });
    expect([...setup!.personIds].sort((a, b) => a - b)).toEqual(ids);
    const [plan] = await h.db.select().from(s.plans);
    expect(plan).toMatchObject({ householdId: "mine", setupId: setup!.id, seed: 42 });
    const portions = await h.db.select().from(s.planSlotPortions);
    expect(portions.every((p) => ids.includes(p.personId))).toBe(true);
    const part = (await h.db.select().from(s.planPartState)).find((r) => r.componentSlug === "new-name");
    expect(part).toMatchObject({ planId: plan!.id, componentSlug: "new-name", mode: "buy" });
    const prep = await h.db.select().from(s.prepTaskState);
    expect(prep.map((p) => p.taskKey)).toEqual([`night:${plan!.id}:fixture`]);
    expect(prep[0]!.householdId).toBe("mine");
  });

  it("dry run counts exactly what a commit writes, then rolls everything back", async () => {
    const text = bundleText(true);
    const before = JSON.stringify(await Promise.all([s.people, s.recipeFeedback, s.plans, s.pantry, s.householdMembers].map((t) => h.db.select().from(t))));
    const dry = await run(text, false);
    expect(dry.dryRun).toBe(true);
    expect(JSON.stringify(await Promise.all([s.people, s.recipeFeedback, s.plans, s.pantry, s.householdMembers].map((t) => h.db.select().from(t))))).toBe(before);
    const real = await run(text, true);
    expect({ ...real, dryRun: true }).toEqual(dry);
  });

  it("refuses a second run, a bundle whose uids exist, and a household that already has data", async () => {
    const text = bundleText(true);
    await run(text);
    await expect(run(text)).rejects.toThrow("already been imported");
    // A rebuilt bundle with the same source has the same uids.
    await expect(run(bundleText(false))).rejects.toThrow("already been imported");
    // No uids in the bundle at all, but the household is no longer empty.
    const empty = JSON.parse(text);
    for (const key of ["recipe_feedback", "recipe_links", "saved_views", "person_routines"]) empty.data[key] = [];
    empty.manifest.counts = {}; empty.manifest.sha256 = dataChecksum(empty.data);
    const { countBundle } = await import("../lib/legacy/bundle");
    empty.manifest.counts = countBundle(empty.data);
    await expect(run(JSON.stringify(empty))).rejects.toThrow("already has");
  });

  it.each([
    ["plans", () => h.db.insert(s.planSetups).values({ householdId: "mine", personIds: [1], startDate: at.slice(0, 10), endDate: at.slice(0, 10), mealTypes: [], cuisineBalance: 0, createdAt: at })],
    ["feedback", () => h.db.insert(s.recipeFeedback).values({ householdId: "mine", recipeId: 1, uid: "existing" })],
    ["links", () => h.db.insert(s.recipeLinks).values({ householdId: "mine", recipeId: 1, uid: "existing", kind: "recipe", url: "https://example.test", title: "t", createdAt: at, updatedAt: at })],
    ["saved views", () => h.db.insert(s.savedViews).values({ householdId: "mine", list: "recipes", name: "n", query: "", uid: "existing" })],
    ["a pantry", () => h.db.insert(s.pantry).values({ householdId: "mine", ingredientId: 1, have: true, alwaysStock: false })],
    ["prep progress", () => h.db.insert(s.prepTaskState).values({ householdId: "mine", date: at.slice(0, 10), taskKey: "k", done: true })],
  ])("refuses a household that already has %s and changes nothing", async (label, seed) => {
    await seed();
    const before = JSON.stringify(await h.db.select().from(s.people));
    await expect(run(bundleText(true))).rejects.toThrow(`already has ${label}`);
    expect(JSON.stringify(await h.db.select().from(s.people))).toBe(before);
  });

  it("refuses a bundle uid that exists in another household", async () => {
    await h.db.insert(s.recipeLinks).values({ householdId: "other-a", recipeId: 1, uid: "link-fixture", kind: "recipe", url: "https://example.test", title: "t", createdAt: at, updatedAt: at });
    await expect(run(bundleText(false))).rejects.toThrow("already been imported");
  });

  it("refuses a bad checksum, a non-owner, an unverified account, another household and a disabled flag", async () => {
    const tampered = JSON.parse(bundleText(false));
    tampered.data.people[0].name = "Tampered";
    await expect(run(JSON.stringify(tampered))).rejects.toThrow("checksum");
    await expect(run(bundleText(false), true, "member")).rejects.toThrow("Only a household owner");
    await expect(accessOf("unverified")).rejects.toThrow(HouseholdAccessError);
    await expect(accessOf("a", "mine")).rejects.toThrow(HouseholdAccessError);
    await expect(importLegacyBundle(h.db, await accessOf("owner"), bundleText(false), { commit: true, env: {} })).rejects.toThrow("not enabled");
    await expect(importLegacyBundle(h.db, await accessOf("owner"), bundleText(false), { commit: true, env: { LEGACY_IMPORT_ENABLED: "yes" } })).rejects.toThrow(LegacyImportError);
    expect(legacyImportEnabled(on)).toBe(true);
    expect(legacyImportEnabled({})).toBe(false);
    expect(legacyImportEnabled()).toBe(process.env.LEGACY_IMPORT_ENABLED === "true");
    expect(await h.db.select().from(s.recipeFeedback).then((rows) => rows.filter((r) => r.householdId === "mine"))).toEqual([]);
  });

  it("an access object revoked before the call cannot import", async () => {
    const access = await accessOf("owner");
    await h.db.update(s.householdMembers).set({ role: "member" });
    await expect(importLegacyBundle(h.db, access, bundleText(false), { commit: true, env: on })).rejects.toThrow(HouseholdAccessError);
  });

  it("links the owner to a named person and removes the empty starter profile", async () => {
    const key = personKey("Synthetic import fixture", "2000-02-29");
    const report = await run(bundleText(false), true, "owner", { linkPerson: key });
    expect(report).toMatchObject({ linkedPerson: true, removedOnboardingProfile: true });
    const [member] = await h.db.select().from(s.householdMembers).then((rows) => rows.filter((r) => r.userId === "owner"));
    const imported = (await h.db.select().from(s.people)).find((p) => p.name === "Synthetic import fixture")!;
    expect(member!.personId).toBe(imported.id);
    expect((await h.db.select().from(s.people)).some((p) => p.id === 1)).toBe(false);
  });

  it("keeps a starter profile that has data of its own, still links, and rejects an unknown person", async () => {
    await h.db.insert(s.habitLog).values({ personId: 1, habitId: 1, date: "2026-11-05", done: true });
    const key = personKey("Synthetic import fixture", "2000-02-29");
    const report = await run(bundleText(false), true, "owner", { linkPerson: key });
    expect(report).toMatchObject({ linkedPerson: true, removedOnboardingProfile: false });
    expect((await h.db.select().from(s.people)).some((p) => p.id === 1)).toBe(true);

    await expect(run(bundleText(false), true, "owner", { linkPerson: "p-0000000000000000" })).rejects.toThrow();
  });

  it("an unknown link person rolls the whole import back", async () => {
    await expect(run(bundleText(true), true, "owner", { linkPerson: "p-0000000000000000" })).rejects.toThrow("not in this bundle");
    expect((await h.db.select().from(s.people)).filter((p) => p.householdId === "mine")).toHaveLength(2);
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ["preference", () => h.db.insert(s.preferences).values({ personId: 1, recipeId: 1, kind: "like" })],
    ["routine", () => h.db.insert(s.personRoutines).values({ personId: 1, habitId: 1, days: [1], timeOfDay: "morning", servings: 1, active: true, uid: "r1" })],
    ["personal feedback", () => h.db.insert(s.personRecipeFeedback).values({ personId: 1, recipeId: 1, uid: "pf", rating: 4, createdAt: at, updatedAt: at })],
    ["push subscription", () => h.db.insert(s.pushSubscriptions).values({ personId: 1, endpoint: "https://example.invalid/e", p256dh: "p", auth: "a", createdAt: at })],
    ["reminder log", () => h.db.insert(s.reminderLog).values({ personId: 1, date: "2026-11-02", sentAt: at })],
    ["reminder batch", () => h.db.insert(s.reminderBatches).values({ householdId: "mine", id: "b1", personId: 1, date: "2026-11-02", payload: { title: "t", body: "b", url: "/" }, expiresAt: at, createdAt: at })],
    ["authored feedback", () => h.db.insert(s.recipeFeedback).values({ householdId: "other-a", recipeId: 2, uid: "cf", createdByPersonId: 1 })],
    ["authored link", () => h.db.insert(s.recipeLinks).values({ householdId: "other-a", recipeId: 1, uid: "cl", kind: "recipe", url: "https://example.test", title: "t", createdAt: at, updatedAt: at, createdByPersonId: 1 })],
    ["authored view", () => h.db.insert(s.savedViews).values({ householdId: "other-a", list: "recipes", name: "n", query: "", uid: "cv", createdByPersonId: 1 })],
    ["authored photo", () => h.db.insert(s.photos).values({ householdId: "other-a", uid: "cp", recipeId: 1, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at, createdByPersonId: 1 })],
    ["photo decision", () => h.db.insert(s.photoDecisions).values({ householdId: "other-a", uid: "cd", subjectKind: "recipe", subjectSlug: "fixture", candidateKey: "k", decision: "rejected", createdAt: at, updatedAt: at, createdByPersonId: 1 })],
  ])("keeps a starter profile referenced by %s", async (_name, add) => {
    await add();
    const report = await run(bundleText(false), false, "owner", { linkPerson: personKey("Synthetic import fixture", "2000-02-29") });
    expect(report).toMatchObject({ linkedPerson: true, removedOnboardingProfile: false });
  });

  it("rolls everything back when a write fails part way", async () => {
    await h.failWrite("plan_slot_portions", "INSERT", "reject_legacy_portions");
    await expect(run(bundleText(true))).rejects.toThrow();
    expect((await h.db.select().from(s.people)).filter((p) => p.householdId === "mine")).toHaveLength(2);
    expect(await h.db.select().from(s.plans)).toEqual([]);
    expect((await h.db.select().from(s.recipeFeedback)).filter((r) => r.householdId === "mine")).toEqual([]);
  });

  it("skips a setup whose person is missing and the plans under it", async () => {
    const edited = JSON.parse(bundleText(true));
    edited.data.plan_setups[0].people.push("p-0000000000000000");
    edited.manifest.sha256 = dataChecksum(edited.data);
    const report = await run(JSON.stringify(edited));
    expect(report.skipped).toMatchObject({ plan_setups: 1, plans: 1 });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("skips rows that name a person or duplicate recipe missing from the bundle", async () => {
    const edited = JSON.parse(bundleText(true));
    const ghost = "p-0000000000000000";
    edited.data.person_routines[0].person = ghost;
    edited.data.habit_log[0].person = ghost;
    edited.data.plans[0].slots[0].portions[0].person = ghost;
    edited.data.plans[0].routines[0].person = ghost;
    edited.data.recipe_feedback.push({ ...edited.data.recipe_feedback.find((r: { recipe: string }) => r.recipe === "fixture"), uid: "duplicate-after-rename" });
    edited.data.plans[0].part_state.push({ component: "old-name", mode: "have", updated_at: at });
    edited.data.prep_tasks.push({ date: "2026-11-03", task_key: "night:@plan-9:2026-11-03:recipe:fixture:0", done: true }, { date: "2026-11-03", task_key: "2026-11-03:date-first", done: true });
    edited.manifest.counts = (await import("../lib/legacy/bundle")).countBundle(edited.data);
    edited.manifest.sha256 = dataChecksum(edited.data);
    const report = await run(JSON.stringify(edited));
    expect(report.skipped).toMatchObject({ person_routines: 1, habit_log: 2, recipe_feedback: 2, plan_slot_portions: 1, plan_routines: 1, plan_part_state: 1, prep_task_state: 1 });
    expect((await h.db.select().from(s.prepTaskState)).map((r) => r.taskKey).sort()).toContain("2026-11-03:date-first");
  });
});
