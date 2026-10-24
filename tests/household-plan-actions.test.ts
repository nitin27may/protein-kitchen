import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../lib/db/schema";
import { loadData } from "../lib/data/load";
import { getRoutineCatalog } from "../lib/routines/catalog";
import { requireMember } from "../lib/auth/access";
import { getData, getDb } from "../lib/server/context";
import { getPlanView } from "../lib/server/queries";
import { loadNight } from "../lib/server/prep";
import { todayISO } from "../lib/server/time";
import { persistNewPlan } from "../lib/server/plan-persistence";
import {
  addManualItem, deletePlan, enableShake, getSwapOptions, markPlanStep, regeneratePlan, removeManualItem,
  setGroceryChecked, setManualChecked, setPartMode, setPortion, setPrepDone, swapSlot, toggleLock, setPersonRoutine, setHabitDone,
  saveDefaultView, clearDefaultView,
  setRecipeFeedback,
  addLink, updateLink, moveLink, removeLink,
} from "../app/actions";
import { openDb, type DbHandle } from "./helpers/db";
import sharp from "sharp";
import { createMemoryStore } from "../lib/blob/memory";
import { getBlobStore } from "../lib/blob";
import { loadCandidates } from "../lib/photos/candidates";
import { photoKeys } from "../lib/photos/keys";
import { uploadRecipePhoto, removePhoto, makeCoverPhoto, rejectPhotoCandidate } from "../app/actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn(), actionDenial: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));
vi.mock("../lib/blob", () => ({ getBlobStore: vi.fn() }));

const data = loadData(process.cwd());
const routine = getRoutineCatalog(data)[0]!;
let h: DbHandle;
let own: number;
let foreign: number;
let ownSlot: number;
let foreignSlot: number;
let ingredientId: number;

beforeEach(async () => {
  vi.mocked(getBlobStore).mockReturnValue(createMemoryStore());
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values(["a", "b"].map((householdId, i) => ({
    id: i + 1, householdId, name: householdId, sex: "other" as const, birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  })));
  await h.db.insert(s.authUsers).values(["a", "b"].map((id) => ({
    id, name: id, email: `${id}@example.test`, emailVerified: true,
  })));
  await h.db.insert(s.householdMembers).values(["a", "b"].map((householdId, i) => ({
    householdId, userId: householdId, personId: i + 1, role: "owner" as const,
  })));
  const recipe = data.recipes.get("falafel-bowl")!;
  const [stored] = await h.db.insert(s.recipes).values({
    slug: recipe.slug, name: recipe.name, kind: recipe.kind, family: recipe.family, mealSlots: recipe.meal_slots,
    cuisine: recipe.cuisine, isIndian: recipe.is_indian, servings: recipe.servings, prepMin: recipe.prep_min,
    activeMin: recipe.active_min, totalMin: recipe.total_min, equipment: recipe.equipment, tags: recipe.tags, fridgeDays: recipe.fridge_days,
  }).returning({ id: s.recipes.id });
  const [ingredient] = await h.db.insert(s.ingredients).values({
    slug: "synthetic-item", name: "Synthetic", state: "ready", source: "USDA", sourceId: "synthetic-fixture",
    aisle: "test", isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    kcal: 100, proteinG: 5, carbsG: 10, fatG: 4, fibreG: 1, aliases: [], whereToBuy: [],
  }).returning({ id: s.ingredients.id });
  ingredientId = ingredient!.id;
  for (const [householdId, personId] of [["a", 1], ["b", 2]] as const) {
    const id = await persistNewPlan(h.db, {
      setup: {
        householdId, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
        cuisineBalance: 0.5, maxActiveMin: 20, healthFocus: { nutrientDense: false, lowSugar: true, light: true },
        prepStyle: "leftovers", createdAt: "2026-10-24T00:00:00Z",
      },
      seed: 42, slots: [{
        date: "2026-11-04", slot: "dinner", recipeSlug: recipe.slug, servings: { [personId]: 1 }, locked: false, reasons: [],
      }], routines: [], recipeIds: new Map([[recipe.slug, stored!.id]]),
    });
    const [slot] = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, id));
    if (householdId === "a") { own = id; ownSlot = slot!.id; }
    else { foreign = id; foreignSlot = slot!.id; }
  }
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
});

it("refuses foreign profile routines/habits while preserving valid owner and member-self writes", async () => {
  const [habit] = await h.db.insert(s.habits).values({
    slug: routine.habitSlug, title: routine.title, category: "routine_drink",
    evidenceGrade: "practical", evidenceNote: "Synthetic fixture", defaultOn: false,
  }).returning({ id: s.habits.id });
  expect((await setPersonRoutine(2, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 2, routine.habitSlug, true)).ok).toBe(false);
  expect(await h.db.select().from(s.personRoutines)).toEqual([]);
  expect(await h.db.select().from(s.habitLog)).toEqual([]);
  expect(await setPersonRoutine(1, routine.habitSlug, { active: true })).toEqual({ ok: true });
  const [stored] = await h.db.select().from(s.personRoutines);
  expect(stored).toMatchObject({ personId: 1, habitId: habit!.id, active: true });
  expect(await h.db.select().from(s.syncState)).toHaveLength(1);
  expect(await setHabitDone("2026-11-02", 1, routine.habitSlug, true)).toEqual({ ok: true });
  expect(await setHabitDone("2026-11-02", 1, routine.habitSlug, false)).toEqual({ ok: true });
  expect(await h.db.select().from(s.habitLog)).toMatchObject([{ personId: 1, done: false }]);
  expect((await setPersonRoutine(1, routine.habitSlug, { active: true, days: [] })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 1, "missing", true)).ok).toBe(false);
  await h.db.update(s.householdMembers).set({ role: "member" }).where(eq(s.householdMembers.userId, "a"));
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "member", personId: 1 });
  expect(await setPersonRoutine(1, routine.habitSlug, { active: false })).toEqual({ ok: true });
  const [other] = await h.db.insert(s.people).values({
    id: 3, householdId: "a", name: "Another synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  expect((await setPersonRoutine(other!.id, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", other!.id, routine.habitSlug, true)).ok).toBe(false);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  expect((await setPersonRoutine(1, routine.habitSlug, { active: true })).ok).toBe(false);
  expect((await setHabitDone("2026-11-02", 1, routine.habitSlug, true)).ok).toBe(false);
});

it("saves updates and clears only the caller's household defaults with stable identity", async () => {
  await h.db.insert(s.savedViews).values([
    { householdId: null, list: "recipes", name: "Legacy", query: "q=legacy", isDefault: true },
    { householdId: "b", list: "recipes", name: "Foreign", query: "q=foreign", isDefault: true },
  ]);
  expect(await saveDefaultView("recipes", "q=first")).toEqual({ ok: true });
  const [first] = await h.db.select().from(s.savedViews).where(eq(s.savedViews.householdId, "a"));
  expect(first).toMatchObject({ householdId: "a", createdByPersonId: 1, query: "q=first" });
  expect(first!.uid).toBeTruthy();
  expect(await saveDefaultView("recipes", "q=updated")).toEqual({ ok: true });
  expect(await h.db.select().from(s.savedViews).where(eq(s.savedViews.householdId, "a")))
    .toMatchObject([{ id: first!.id, uid: first!.uid, query: "q=updated" }]);
  expect(await saveDefaultView("ingredients", "q=tofu")).toEqual({ ok: true });
  expect(await clearDefaultView("recipes")).toEqual({ ok: true });
  expect(await clearDefaultView("recipes")).toEqual({ ok: true });
  expect(await h.db.select().from(s.savedViews)).toMatchObject([
    { householdId: null, query: "q=legacy" }, { householdId: "b", query: "q=foreign" },
    { householdId: "a", list: "ingredients", query: "q=tofu" },
  ]);
  for (const call of [
    () => saveDefaultView("unknown", ""), () => saveDefaultView("recipes", "<script>"),
    () => clearDefaultView("unknown"),
  ]) expect((await call()).ok).toBe(false);
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "a"));
  expect((await saveDefaultView("recipes", "q=blocked")).ok).toBe(false);
  expect((await clearDefaultView("ingredients")).ok).toBe(false);
  await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "a"));
  await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "a"));
  expect((await saveDefaultView("recipes", "q=blocked")).ok).toBe(false);
  expect((await clearDefaultView("ingredients")).ok).toBe(false);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  expect((await saveDefaultView("recipes", "q=blocked")).ok).toBe(false);
  expect((await clearDefaultView("ingredients")).ok).toBe(false);
});

it("keeps same-recipe feedback independent across households and refuses stale accounts", async () => {
  expect(await setRecipeFeedback("falafel-bowl", { rating: 5, notes: "First household", banned: false })).toEqual({ ok: true });
  const [first] = await h.db.select().from(s.recipeFeedback);
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect(await setRecipeFeedback("falafel-bowl", { rating: 1, notes: "Second household", banned: true })).toEqual({ ok: true });
  expect(await h.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, "a"))).toEqual([first]);
  expect(await h.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, "b")))
    .toMatchObject([{ notes: "Second household", banned: true, status: "tested" }]);
  expect(await setRecipeFeedback("falafel-bowl", { tested: false, notes: "Updated second household" })).toEqual({ ok: true });
  expect(await h.db.select().from(s.recipeFeedback).where(eq(s.recipeFeedback.householdId, "b")))
    .toMatchObject([{ status: "draft", notes: "Updated second household" }]);
  expect((await setRecipeFeedback("missing", { favourite: true })).ok).toBe(false);
  expect((await setRecipeFeedback("falafel-bowl", { rating: 6 })).ok).toBe(false);
  await h.db.update(s.householdMembers).set({ personId: null }).where(eq(s.householdMembers.userId, "b"));
  expect((await setRecipeFeedback("falafel-bowl", { favourite: true })).ok).toBe(false);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "b"));
  expect((await setRecipeFeedback("falafel-bowl", { favourite: true })).ok).toBe(false);
  expect(await h.db.select().from(s.personRecipeFeedback)).toMatchObject([{ personId: 1, rating: 5 }, { personId: 2, rating: 1 }]);
});

it("rolls personal and household feedback back together when shared sync marking fails", async () => {
  await h.db.execute(sql`alter table sync_state add constraint synthetic_feedback_sync_failure check (data_class <> 'recipe-feedback')`);
  await expect(setRecipeFeedback("falafel-bowl", { rating: 5, notes: "Must roll back" })).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.personRecipeFeedback)).toEqual([]);
  expect(await h.db.select().from(s.recipeFeedback)).toEqual([]);
  expect(await h.db.select().from(s.syncState)).toEqual([]);
});

it("isolates shared link creation editing ordering and deletion, including owner-level foreign ids", async () => {
  const input = { recipeSlug: "falafel-bowl", kind: "recipe" as const, url: "https://example.com/recipe", title: "Synthetic method" };
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  const foreign = await addLink(input);
  expect(foreign.ok).toBe(true);
  if (!foreign.ok) throw new Error(foreign.error);
  const [foreignRow] = await h.db.select().from(s.recipeLinks);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
  for (const call of [
    () => updateLink(foreign.id, { ...input, title: "Must not change" }),
    () => moveLink(foreign.id, "up"), () => removeLink(foreign.id),
    () => removeLink(NaN), () => moveLink(999, "down"),
  ]) expect((await call()).ok).toBe(false);
  const first = await addLink(input);
  const second = await addLink({ ...input, url: "https://example.com/other" });
  if (!first.ok || !second.ok) throw new Error("Owned fixture creation failed");
  const [before] = await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, first.id));
  expect(before).toMatchObject({ householdId: "a", position: 0, createdByPersonId: 1 });
  expect((await addLink(input)).ok).toBe(false);
  expect(await updateLink(first.id, { ...input, title: "Updated own method" })).toEqual({ ok: true });
  expect(await moveLink(second.id, "up")).toEqual({ ok: true });
  expect(await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, first.id)))
    .toMatchObject([{ uid: before!.uid, createdAt: before!.createdAt, title: "Updated own method", position: 1 }]);
  expect(await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, second.id))).toMatchObject([{ position: 0 }]);
  expect(await h.db.select().from(s.recipeLinks).where(eq(s.recipeLinks.id, foreign.id))).toEqual([foreignRow]);
  expect(await removeLink(first.id)).toEqual({ ok: true });
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "a"));
  expect((await addLink(input)).ok).toBe(false);
  expect((await removeLink(second.id)).ok).toBe(false);
});

it("rolls link creation back with its human sync marker on database failure", async () => {
  await h.db.execute(sql`alter table sync_state add constraint synthetic_link_sync_failure check (data_class <> 'recipe-links')`);
  await expect(addLink({
    recipeSlug: "falafel-bowl", kind: "recipe", url: "https://example.com/rollback", title: "Must roll back",
  })).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.recipeLinks)).toEqual([]);
});

it("binds actual photo upload cover delete and rejection actions to the household without changing another household's bytes", async () => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const upload = () => {
    const form = new FormData();
    form.set("recipe", "falafel-bowl"); form.set("photo", new File([Uint8Array.from(bytes)], "fixture.jpg", { type: "image/jpeg" }));
    return uploadRecipePhoto(form);
  };
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  const foreign = await upload();
  if (!foreign.ok) throw new Error(foreign.error);
  const [foreignRow] = await h.db.select().from(s.photos);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
  expect(await makeCoverPhoto(foreign.uid)).toMatchObject({ ok: false });
  expect(await removePhoto(foreign.uid)).toMatchObject({ ok: false });
  const own = await upload();
  const second = await upload();
  if (!own.ok || !second.ok) throw new Error("Synthetic upload failed");
  expect(await makeCoverPhoto(second.uid)).toEqual({ ok: true });
  const ownRows = await h.db.select().from(s.photos).where(eq(s.photos.householdId, "a"));
  expect(ownRows).toMatchObject([{ createdByPersonId: 1, isCover: false }, { createdByPersonId: 1, isCover: true }]);
  expect(await removePhoto(second.uid)).toEqual({ ok: true });
  expect((await h.db.select().from(s.photos).where(eq(s.photos.uid, own.uid)))[0]).toMatchObject({ isCover: true });
  expect(await getBlobStore().exists(photoKeys(second.uid).master)).toBe(false);
  expect(await getBlobStore().exists(photoKeys(foreign.uid).master)).toBe(true);
  expect(await h.db.select().from(s.photos).where(eq(s.photos.uid, foreign.uid))).toEqual([foreignRow]);
  const [slug, candidates] = Object.entries(loadCandidates(process.cwd()).recipes).find(([, rows]) => rows.length)!;
  const key = candidates[0]!.key;
  expect(await rejectPhotoCandidate("recipe", slug, key)).toEqual({ ok: true });
  vi.mocked(requireMember).mockResolvedValue({ userId: "b", role: "owner", personId: 2 });
  expect(await rejectPhotoCandidate("recipe", slug, key)).toEqual({ ok: true });
  expect((await h.db.select().from(s.photoDecisions)).map((r) => [r.householdId, r.createdByPersonId])).toEqual([["a", 1], ["b", 2]]);
  await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "b"));
  expect((await removePhoto(foreign.uid)).ok).toBe(false);
  expect((await upload()).ok).toBe(false);
});

it("rolls failed photo SQL and markers back and cleans only newly staged bytes, with storage outside locks", async () => {
  const { writeUploadedPhoto } = await import("../lib/human/photos");
  const { resolveHouseholdAccess } = await import("../lib/auth/household-access");
  const { mutateHouseholdState } = await import("../lib/server/household-plans");
  const access = await resolveHouseholdAccess(h.db, "a", "a");
  const [recipe] = await h.db.select().from(s.recipes);
  let locked = false;
  const store = getBlobStore();
  const put = store.put.bind(store), drop = store.delete.bind(store);
  vi.spyOn(store, "put").mockImplementation(async (...args) => { expect(locked).toBe(false); await put(...args); });
  vi.spyOn(store, "delete").mockImplementation(async (...args) => { expect(locked).toBe(false); await drop(...args); });
  const scope = {
    householdId: "a", personId: 1,
    commit: <T>(work: (tx: import("../lib/db/tx").Tx) => Promise<T>) =>
      mutateHouseholdState(h.db, access, async (tx) => {
        locked = true;
        try { return await work(tx); } finally { locked = false; }
      }),
  };
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const saved = await writeUploadedPhoto(h.db, store, { ...scope, subject: { kind: "recipe", recipeId: recipe!.id }, bytes });
  await h.db.execute(sql`delete from sync_state`);
  await h.db.execute(sql`alter table sync_state add constraint synthetic_photo_sync_failure check (data_class <> 'photos')`);
  await expect(removePhoto(saved.uid)).rejects.toThrow("sync_state");
  expect(await store.exists(photoKeys(saved.uid).master)).toBe(true);
  await expect(writeUploadedPhoto(h.db, store, { ...scope, subject: { kind: "recipe", recipeId: recipe!.id }, bytes })).rejects.toThrow("sync_state");
  expect((await store.list()).sort()).toEqual(Object.values(photoKeys(saved.uid)).sort());
  expect(await h.db.select().from(s.photos)).toHaveLength(1);
  expect(await h.db.select().from(s.syncState)).toEqual([]);
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  await expect(writeUploadedPhoto(h.db, store, { ...scope, subject: { kind: "recipe", recipeId: recipe!.id }, bytes })).rejects.toThrow("not available");
  expect((await store.list()).sort()).toEqual(Object.values(photoKeys(saved.uid)).sort());
});

it("keeps legacy links separate, limits only the current household and rolls edits removals and ordering back", async () => {
  const [recipe] = await h.db.select().from(s.recipes).where(eq(s.recipes.slug, "falafel-bowl"));
  const [legacy] = await h.db.insert(s.recipeLinks).values({
    recipeId: recipe!.id, uid: "legacy-link", kind: "recipe", url: "https://example.com/legacy",
    title: "Legacy", position: 99, createdAt: "2026-11-02", updatedAt: "2026-11-02",
  }).returning();
  expect((await removeLink(legacy!.id)).ok).toBe(false);
  const input = { recipeSlug: "falafel-bowl", kind: "recipe" as const, title: "Owned", url: "https://example.com/legacy" };
  for (let i = 0; i < 12; i++) expect((await addLink({ ...input, url: i === 0 ? input.url : `https://example.com/limit-${i}` })).ok).toBe(true);
  expect(await addLink({ ...input, url: "https://example.com/overflow" })).toMatchObject({ ok: false, error: expect.stringContaining("up to 12") });
  const before = await h.db.select().from(s.recipeLinks).orderBy(s.recipeLinks.id);
  const owned = before.filter((row) => row.householdId === "a");
  await h.db.execute(sql`delete from sync_state`);
  await h.db.execute(sql`alter table sync_state add constraint synthetic_link_edit_failure check (data_class <> 'recipe-links')`);
  for (const change of [
    () => updateLink(owned[0]!.id, { ...input, title: "Must roll back" }),
    () => removeLink(owned[0]!.id), () => moveLink(owned[1]!.id, "up"),
  ]) {
    await expect(change()).rejects.toThrow("sync_state");
    expect(await h.db.select().from(s.recipeLinks).orderBy(s.recipeLinks.id)).toEqual(before);
    expect(await h.db.select().from(s.syncState)).toEqual([]);
  }
});

it("rolls saved defaults and deletion back when sync marking fails", async () => {
  await h.db.execute(sql`alter table sync_state add constraint synthetic_view_sync_failure check (data_class <> 'saved-views')`);
  await expect(saveDefaultView("recipes", "q=rollback")).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.savedViews)).toEqual([]);
  await h.db.insert(s.savedViews).values({ householdId: "a", list: "recipes", name: "Keep", query: "q=keep", isDefault: true });
  await expect(clearDefaultView("recipes")).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.savedViews)).toMatchObject([{ query: "q=keep" }]);
});

it("propagates profile infrastructure failures and rolls routine choices and sync markers back together", async () => {
  await h.db.insert(s.habits).values({
    slug: routine.habitSlug, title: routine.title, category: "routine_drink",
    evidenceGrade: "practical", evidenceNote: "Synthetic fixture", defaultOn: false,
  });
  await h.db.execute(sql`alter table sync_state add constraint synthetic_sync_failure check (data_class <> 'person-routines')`);
  await expect(setPersonRoutine(1, routine.habitSlug, { active: true })).rejects.toThrow("sync_state");
  expect(await h.db.select().from(s.personRoutines)).toEqual([]);
  expect(await h.db.select().from(s.syncState)).toEqual([]);
});

it("refuses every foreign plan and shopping mutation even for a household owner", async () => {
  const [item] = await h.db.insert(s.groceryManual).values({ planId: foreign, text: "Foreign", checked: false }).returning({ id: s.groceryManual.id });
  const before = await h.db.select().from(s.planSlots);
  for (const action of [
    () => toggleLock(foreign, foreignSlot, true),
    () => setPortion(foreign, foreignSlot, 2, 2),
    () => deletePlan(foreign),
    () => regeneratePlan(foreign),
    () => enableShake(foreign),
    () => getSwapOptions(foreign, foreignSlot),
    () => swapSlot(foreign, foreignSlot, "falafel-bowl"),
    () => markPlanStep(foreign, "shopping"),
    () => setGroceryChecked(foreign, "synthetic-item", true),
    () => addManualItem(foreign, "Must never persist"),
    () => setManualChecked(item!.id, true),
    () => removeManualItem(item!.id),
    () => setPartMode(foreign, "baked-falafel", "have"),
    () => setPrepDone("2026-11-03", `night:${foreign}:2026-11-03:component:baked-falafel:0`, true),
  ]) expect((await action()).ok).toBe(false);
  expect(await h.db.select().from(s.planSlots)).toEqual(before);
  expect(await h.db.select().from(s.groceryManual)).toMatchObject([{ planId: foreign, checked: false }]);
  expect(await h.db.select().from(s.plans)).toHaveLength(2);
  for (const table of [s.groceryState, s.planProgress, s.planPartState, s.prepTaskState]) {
    expect(await h.db.select().from(table)).toEqual([]);
  }
});

it("persists valid owned slot, portion, milestone, shopping and part changes", async () => {
  expect(await toggleLock(own, ownSlot, true)).toEqual({ ok: true });
  expect(await setPortion(own, ownSlot, 1, 2.26)).toEqual({ ok: true });
  expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, ownSlot)))[0]!.locked).toBe(true);
  expect((await h.db.select().from(s.planSlotPortions).where(eq(s.planSlotPortions.planSlotId, ownSlot)))[0]!.servings).toBe(2.25);
  expect(await markPlanStep(own, "shopping")).toEqual({ ok: true });
  expect(await setGroceryChecked(own, "synthetic-item", true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryState)).toMatchObject([{ planId: own, ingredientId, checked: true }]);
  const added = await addManualItem(own, " Synthetic shopping ");
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error("Synthetic item was not saved.");
  expect(await setManualChecked(added.id, true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryManual)).toMatchObject([{ text: "Synthetic shopping", checked: true }]);
  expect(await removeManualItem(added.id)).toEqual({ ok: true });
  expect(await h.db.select().from(s.groceryManual)).toEqual([]);
  expect(await setPartMode(own, "baked-falafel", "have")).toEqual({ ok: true });
  expect(await h.db.select().from(s.planPartState)).toMatchObject([{ planId: own, componentSlug: "baked-falafel", mode: "have" }]);
});

it("refuses foreign child ids, invalid portions, missing items and stale membership", async () => {
  expect((await toggleLock(own, foreignSlot, true)).ok).toBe(false);
  expect((await setPortion(own, ownSlot, 2, 1)).ok).toBe(false);
  for (const servings of [NaN, Infinity, -1, 5]) expect((await setPortion(own, ownSlot, 1, servings)).ok).toBe(false);
  for (const id of [-1, 999]) {
    expect((await toggleLock(id, ownSlot, true)).ok).toBe(false);
    expect((await setManualChecked(id, true)).ok).toBe(false);
    expect((await removeManualItem(id)).ok).toBe(false);
  }
  for (const id of [NaN, Infinity, 0]) {
    expect((await regeneratePlan(id)).ok).toBe(false);
    expect((await enableShake(id)).ok).toBe(false);
  }
  await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
  expect((await toggleLock(own, ownSlot, true)).ok).toBe(false);
  expect((await addManualItem(own, "No stale writes")).ok).toBe(false);
});

it("writes prep ownership and refuses an existing foreign completion instead of transferring it", async () => {
  const view = (await getPlanView(own, []))!;
  const task = (await loadNight(view, todayISO())).tasks[0]!;
  expect(task).toBeDefined();
  expect(await setPrepDone("1900-01-01", task.key, true)).toEqual({ ok: true });
  expect(await h.db.select().from(s.prepTaskState)).toEqual([
    { householdId: "a", date: task.dueDate, taskKey: task.key, done: true },
  ]);
  await h.db.update(s.prepTaskState).set({ householdId: "b" });
  expect((await setPrepDone(task.dueDate, task.key, false)).ok).toBe(false);
  expect(await h.db.select().from(s.prepTaskState)).toMatchObject([{ householdId: "b", done: true }]);
});

it("propagates persistence failures and rolls shake setup changes back when regeneration fails", async () => {
  await h.failWrite("plan_slots", "UPDATE", "synthetic_lock_failure");
  await expect(toggleLock(own, ownSlot, true)).rejects.toThrow();
  expect((await h.db.select().from(s.planSlots).where(eq(s.planSlots.id, ownSlot)))[0]!.locked).toBe(false);
  await h.dropFailure("plan_slots", "synthetic_lock_failure");
  const before = await h.db.select().from(s.planSetups);
  await h.failWrite("plan_slots", "INSERT", "synthetic_regeneration_failure");
  await expect(enableShake(own)).rejects.toThrow();
  expect(await h.db.select().from(s.planSetups)).toEqual(before);
});
