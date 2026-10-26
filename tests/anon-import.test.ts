import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importAnonymousDraft, replayPendingIntent, setRecipeFeedback } from "../app/actions";
import { requireMember, actionDenial } from "../lib/auth/access";
import { loadData } from "../lib/data/load";
import { seedDatabase } from "../lib/db/seed";
import * as s from "../lib/db/schema";
import { AnonProfileSchema, savePendingIntent, serializePendingIntent, type AnonDraft, type AnonStores } from "../lib/plan/anon-draft";
import { draftSwapOptions, swapDraftSlot, toggleDraftLock } from "../lib/plan/anon-edit";
import { generateAnonPlan } from "../lib/plan/anon-generate";
import { hydrateAnonLibrary } from "../lib/plan/anon-library";
import { anonLibrary } from "../lib/server/anon-library";
import { getData, getDb } from "../lib/server/context";
import { replayIntent } from "../lib/server/pending-intent";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn(), actionDenial: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));

const data = loadData(process.cwd());
const now = new Date();
const setup = {
  personIds: [1], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["breakfast", "lunch", "dinner"] as ("breakfast" | "lunch" | "dinner")[],
  cuisineBalance: 0.5, maxActiveMin: null, pinned: [], prefs: { "1": { liked: [], avoided: [] } },
};
const profile = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 110 } });
let h: DbHandle;

function makeDraft(extra: Partial<typeof setup> = {}, seed = 31337): AnonDraft {
  const result = generateAnonPlan({ setup: { ...setup, ...extra }, profile, library: hydrateAnonLibrary(JSON.parse(anonLibrary(data).body)), seed, now });
  if (!result.ok) throw new Error(result.error);
  return result.draft;
}

beforeEach(async () => {
  h = await openDb();
  await seedDatabase(h.db, data);
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([
    { id: 1, householdId: "a", name: "A", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", proteinTargetG: 110, dietFlags: [] },
    { id: 2, householdId: "b", name: "B", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", proteinTargetG: 110, dietFlags: [] },
  ]);
  await h.db.insert(s.authUsers).values(["a", "b"].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));
  await h.db.insert(s.householdMembers).values([
    { householdId: "a", userId: "a", personId: 1, role: "owner" as const },
    { householdId: "b", userId: "b", personId: 2, role: "owner" as const },
  ]);
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(getData).mockReturnValue(data);
  vi.mocked(actionDenial).mockResolvedValue(null);
  vi.mocked(requireMember).mockResolvedValue({ userId: "a", role: "owner", personId: 1 });
});

const plansOf = (householdId: string) => h.db.select().from(s.plans).where(eq(s.plans.householdId, householdId));

describe("importAnonymousDraft", () => {
  it("saves the server-built plan for the member's household with the draft's seed", async () => {
    const draft = makeDraft();
    const result = await importAnonymousDraft(draft);
    expect(result).toMatchObject({ ok: true, changed: false, libraryChanged: false });
    if (!result.ok) return;
    const [plan] = await plansOf("a");
    expect(plan).toMatchObject({ id: result.planId, seed: 31337 });
    expect(await plansOf("b")).toEqual([]);
    const slots = await h.db.select().from(s.planSlots).where(eq(s.planSlots.planId, result.planId));
    expect(slots.length).toBe(draft.slots.length);
    const portions = await h.db.select().from(s.planSlotPortions);
    expect(portions.every((p) => p.personId === 1)).toBe(true);
    const [setupRow] = await h.db.select().from(s.planSetups);
    expect(setupRow).toMatchObject({ householdId: "a", personIds: [1], startDate: "2026-11-02", endDate: "2026-11-08" });
  });

  it("never trusts client slots: a tampered draft is replaced by the server's plan and flagged", async () => {
    const draft = makeDraft();
    const forged: AnonDraft = {
      ...draft, slots: draft.slots.map((x, i) => (i === 0 ? { ...x, recipeSlug: "not-a-real-recipe" } : x)),
      portions: Object.fromEntries(Object.keys(draft.portions).map((k) => [k, 4])),
    };
    const result = await importAnonymousDraft(forged);
    expect(result).toMatchObject({ ok: true, changed: true, libraryChanged: false });
    const stored = await h.db.select({ slug: s.recipes.slug }).from(s.planSlots).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId));
    expect(stored.map((r) => r.slug)).not.toContain("not-a-real-recipe");
    const portions = await h.db.select().from(s.planSlotPortions);
    expect(portions.every((p) => p.servings <= 2)).toBe(true);
  });

  it("keeps the meals chosen on the device: a swap and a lock are saved as the person left them", async () => {
    const draft = makeDraft();
    const lib = hydrateAnonLibrary(JSON.parse(anonLibrary(data).body));
    const swapped = swapDraftSlot(draft, profile, lib, { date: draft.slots[0]!.date, slot: draft.slots[0]!.slot }, draftSwapOptions(draft, profile, lib, { date: draft.slots[0]!.date, slot: draft.slots[0]!.slot })[0]!.slug);
    if (!swapped.ok) throw new Error(swapped.error);
    const locked = toggleDraftLock(swapped.draft, { date: draft.slots[1]!.date, slot: draft.slots[1]!.slot }, true);
    if (!locked.ok) throw new Error(locked.error);
    const result = await importAnonymousDraft(locked.draft);
    expect(result).toMatchObject({ ok: true, changed: false });
    if (!result.ok) return;
    const rows = await h.db.select({ date: s.planSlots.date, slot: s.planSlots.slot, slug: s.recipes.slug, locked: s.planSlots.locked })
      .from(s.planSlots).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId)).where(eq(s.planSlots.planId, result.planId));
    const key = (x: { date: string; slot: string }) => `${x.date}|${x.slot}`;
    const stored = new Map(rows.map((r) => [key(r), r]));
    for (const slot of locked.draft.slots) expect(stored.get(key(slot))).toMatchObject({ slug: slot.recipeSlug, locked: slot.locked });
    expect(stored.get(key(draft.slots[0]!))!.slug).not.toBe(draft.slots[0]!.recipeSlug);
  });

  it("refuses a device swap to a recipe the household banned, a shake in a meal slot or an avoided ingredient", async () => {
    const draft = makeDraft();
    const lib = hydrateAnonLibrary(JSON.parse(anonLibrary(data).body));
    const ref = { date: draft.slots[0]!.date, slot: draft.slots[0]!.slot };
    const pick = draftSwapOptions(draft, profile, lib, ref)[0]!.slug;
    const swapped = swapDraftSlot(draft, profile, lib, ref, pick);
    if (!swapped.ok) throw new Error(swapped.error);
    expect(await setRecipeFeedback(pick, { banned: true })).toEqual({ ok: true });
    const result = await importAnonymousDraft(swapped.draft);
    expect(result).toMatchObject({ ok: true, changed: true });
    const stored = await h.db.select({ slug: s.recipes.slug }).from(s.planSlots).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId));
    expect(stored.map((r) => r.slug)).not.toContain(pick);
    const shake = lib.candidates.find((c) => c.family === "shakes")!.slug;
    const forged = { ...swapped.draft, slots: swapped.draft.slots.map((x, i) => (i === 0 ? { ...x, recipeSlug: shake } : x)) };
    expect(await importAnonymousDraft(forged)).toMatchObject({ ok: true, changed: true });
  });

  it("flags a library change but still saves the server version", async () => {
    const result = await importAnonymousDraft({ ...makeDraft(), libraryVersion: "older-library" });
    expect(result).toMatchObject({ ok: true, libraryChanged: true, changed: false });
    expect(await plansOf("a")).toHaveLength(1);
  });

  it("uses the household's feedback: a recipe the household banned does not come back", async () => {
    const draft = makeDraft();
    const first = draft.slots[0]!.recipeSlug;
    expect(await setRecipeFeedback(first, { banned: true })).toEqual({ ok: true });
    const result = await importAnonymousDraft(draft);
    expect(result).toMatchObject({ ok: true, changed: true });
    const stored = await h.db.select({ slug: s.recipes.slug }).from(s.planSlots).innerJoin(s.recipes, eq(s.recipes.id, s.planSlots.recipeId));
    expect(stored.map((r) => r.slug)).not.toContain(first);
  });

  it("merges likes and avoids from the device into the saved profile, after the plan is saved", async () => {
    const [avoid] = [...hydrateAnonLibrary(JSON.parse(anonLibrary(data).body)).candidates.find((c) => c.slug === makeDraft().slots[0]!.recipeSlug)!.ingredients];
    const draft = makeDraft();
    const result = await importAnonymousDraft({ ...draft, setup: { ...draft.setup, prefs: { "1": { liked: [], avoided: [avoid!] } } } });
    expect(result).toMatchObject({ ok: true, changed: true });
    const prefs = await h.db.select().from(s.preferences).where(eq(s.preferences.personId, 1));
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ kind: "avoid" });
  });

  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["unknown fields", { extra: true }],
    ["wrong version", { version: 99 }],
  ])("rejects %s without writing", async (_l, bad) => {
    const input = typeof bad === "object" && bad !== null ? { ...makeDraft(), ...bad } : bad;
    const result = await importAnonymousDraft(input);
    expect(result).toMatchObject({ ok: false });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("refuses an expired draft, impossible dates and an empty result", async () => {
    const old = makeDraft();
    expect(await importAnonymousDraft({ ...old, createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString() })).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(await importAnonymousDraft({ ...old, setup: { ...old.setup, endDate: "2026-10-01" } })).toMatchObject({ ok: false });
    expect(await importAnonymousDraft({ ...old, setup: { ...old.setup, pinned: [], maxActiveMin: 1 } })).toMatchObject({ ok: false });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("is denied without a member and writes nothing", async () => {
    vi.mocked(actionDenial).mockResolvedValue({ ok: false, error: "Sign in before continuing." });
    expect(await importAnonymousDraft(makeDraft())).toEqual({ ok: false, error: "Sign in before continuing." });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("refuses a member whose profile is missing from the household", async () => {
    await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "a"));
    expect(await importAnonymousDraft(makeDraft())).toMatchObject({ ok: false });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });
});

describe("replayPendingIntent", () => {
  const intent = (input: Parameters<typeof serializePendingIntent>[0]) => serializePendingIntent(input, new Date());

  it("saves the plan for a save-plan intent and points at it", async () => {
    const result = await replayPendingIntent(intent({ kind: "save-plan", returnTo: "/plan/new" }), makeDraft());
    expect(result).toMatchObject({ ok: true, replay: { ok: true, kind: "save-plan", changed: false } });
    const [plan] = await plansOf("a");
    expect(result.ok && result.replay.ok && result.replay.redirectTo).toBe(`/plan/${plan!.id}`);
  });

  it("reports a missing or unreadable draft without writing", async () => {
    expect(await replayPendingIntent(intent({ kind: "save-plan", returnTo: "/" }))).toMatchObject({ ok: true, replay: { ok: false, error: expect.stringContaining("no longer on this device") } });
    expect(await replayPendingIntent(intent({ kind: "save-plan", returnTo: "/" }), { bad: 1 })).toMatchObject({ ok: true, replay: { ok: false } });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("favourites through the existing feedback path and returns to the page", async () => {
    const result = await replayPendingIntent(intent({ kind: "favourite", slug: "falafel-bowl", returnTo: "/recipes/falafel-bowl" }));
    expect(result).toMatchObject({ ok: true, replay: { ok: true, kind: "favourite", redirectTo: "/recipes/falafel-bowl" } });
    const rows = await h.db.select().from(s.personRecipeFeedback);
    expect(rows).toMatchObject([{ personId: 1, favourite: true }]);
    expect(await h.db.select().from(s.syncState)).not.toEqual([]);
  });

  it.each([
    [{ kind: "rate" as const, slug: "falafel-bowl", value: 4 }, "personal", { rating: 4 }],
    [{ kind: "ban" as const, slug: "falafel-bowl" }, "shared", { banned: true }],
    [{ kind: "tested" as const, slug: "falafel-bowl" }, "shared", { status: "tested" }],
  ])("replays %j through the feedback path, once or twice", async (partial, where, expected) => {
    for (let i = 0; i < 2; i++) {
      const result = await replayPendingIntent(intent({ ...partial, returnTo: "/recipes/falafel-bowl" }));
      expect(result).toMatchObject({ ok: true, replay: { ok: true, kind: partial.kind, redirectTo: "/recipes/falafel-bowl" } });
    }
    const [recipe] = await h.db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, "falafel-bowl"));
    const rows = where === "personal"
      ? await h.db.select().from(s.personRecipeFeedback)
      : await h.db.select().from(s.recipeFeedback).where(and(eq(s.recipeFeedback.recipeId, recipe!.id), eq(s.recipeFeedback.householdId, "a")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(expected);
    if (where === "personal") expect(rows[0]).toMatchObject({ personId: 1 });
    expect(await h.db.select().from(s.syncState)).not.toEqual([]);
  });

  it.each([
    [{ kind: "rate" as const, slug: "no-such-recipe", value: 4 }],
    [{ kind: "ban" as const, slug: "no-such-recipe" }],
    [{ kind: "tested" as const, slug: "no-such-recipe" }],
  ])("fails safely for an unknown recipe on %j", async (partial) => {
    const before = (await h.db.select().from(s.recipeFeedback)).length;
    expect(await replayPendingIntent(intent({ ...partial, returnTo: "/" }))).toMatchObject({ ok: true, replay: { ok: false, error: "Recipe not found" } });
    expect(await h.db.select().from(s.personRecipeFeedback)).toEqual([]);
    expect(await h.db.select().from(s.recipeFeedback)).toHaveLength(before);
  });

  it("refuses a stored rating outside 1 to 5 without writing", async () => {
    const raw = JSON.stringify({ kind: "rate", slug: "falafel-bowl", value: 9, returnTo: "/", createdAt: new Date().toISOString() });
    expect(await replayPendingIntent(raw)).toMatchObject({ ok: false });
    expect(await h.db.select().from(s.personRecipeFeedback)).toEqual([]);
  });

  it("reports an unknown recipe for a favourite", async () => {
    expect(await replayPendingIntent(intent({ kind: "favourite", slug: "no-such-recipe", returnTo: "/" }))).toMatchObject({ ok: true, replay: { ok: false, error: "Recipe not found" } });
  });

  it("makes an unsafe returnTo harmless and rejects expired or malformed intents", async () => {
    const result = await replayPendingIntent(intent({ kind: "favourite", slug: "falafel-bowl", returnTo: "//evil.example" }));
    expect(result.ok && result.replay.ok && result.replay.redirectTo).toBe("/");
    const stale = serializePendingIntent({ kind: "save-plan", returnTo: "/" }, new Date(Date.now() - 2 * 86_400_000));
    expect(await replayPendingIntent(stale)).toMatchObject({ ok: false });
    expect(await replayPendingIntent("{bad")).toMatchObject({ ok: false });
  });

  it("is denied without a member", async () => {
    vi.mocked(actionDenial).mockResolvedValue({ ok: false, error: "Sign in before continuing." });
    expect(await replayPendingIntent(intent({ kind: "save-plan", returnTo: "/" }), makeDraft())).toEqual({ ok: false, error: "Sign in before continuing." });
    expect(await h.db.select().from(s.plans)).toEqual([]);
  });

  it("an intent written by the browser helpers replays", async () => {
    const stores: AnonStores = { session: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, local: null };
    let saved = "";
    stores.session = { getItem: () => saved, setItem: (_k, v) => { saved = v; }, removeItem: () => undefined };
    savePendingIntent(stores, { kind: "favourite", slug: "falafel-bowl", returnTo: "/recipes/falafel-bowl" }, new Date());
    expect(await replayPendingIntent(saved)).toMatchObject({ ok: true, replay: { ok: true } });
  });
});

describe("replayIntent dispatcher", () => {
  const base = { returnTo: "/back", createdAt: new Date().toISOString() };
  const savePlan = vi.fn();
  const favourite = vi.fn();
  beforeEach(() => { savePlan.mockReset(); favourite.mockReset(); });

  it("routes each kind to its handler only", async () => {
    savePlan.mockResolvedValue({ ok: true, planId: 7, changed: true, libraryChanged: true });
    favourite.mockResolvedValue({ ok: true });
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan, favourite }, { d: 1 })).toEqual({
      ok: true, kind: "save-plan", redirectTo: "/plan/7", planId: 7, changed: true, libraryChanged: true,
    });
    expect(savePlan).toHaveBeenCalledWith({ d: 1 });
    expect(await replayIntent({ kind: "favourite", slug: "a-b", ...base }, { savePlan, favourite })).toEqual({ ok: true, kind: "favourite", redirectTo: "/back" });
    expect(favourite).toHaveBeenCalledWith("a-b");
    expect(savePlan).toHaveBeenCalledTimes(1);
  });

  it("passes handler failures through and rejects a save with no plan id", async () => {
    savePlan.mockResolvedValueOnce({ ok: false, error: "nope" }).mockResolvedValueOnce({ ok: true });
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan }, {})).toEqual({ ok: false, kind: "save-plan", error: "nope" });
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan }, {})).toMatchObject({ ok: false });
    favourite.mockResolvedValue({ ok: false, error: "Recipe not found" });
    expect(await replayIntent({ kind: "favourite", slug: "a-b", ...base }, { favourite })).toEqual({ ok: false, kind: "favourite", error: "Recipe not found" });
    savePlan.mockResolvedValue({ ok: true, planId: 3 });
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan }, {})).toMatchObject({ ok: true, changed: false, libraryChanged: false });
  });

  it("requires a draft for save-plan", async () => {
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan })).toMatchObject({ ok: false });
    expect(await replayIntent({ kind: "save-plan", ...base }, { savePlan }, null)).toMatchObject({ ok: false });
    expect(savePlan).not.toHaveBeenCalled();
  });

  it("routes rate, ban and tested to their own handlers with validated arguments", async () => {
    const rate = vi.fn().mockResolvedValue({ ok: true });
    const ban = vi.fn().mockResolvedValue({ ok: true });
    const tested = vi.fn().mockResolvedValue({ ok: false, error: "Recipe not found" });
    const handlers = { rate, ban, tested };
    expect(await replayIntent({ kind: "rate", slug: "a-b", value: 4, ...base }, handlers)).toEqual({ ok: true, kind: "rate", redirectTo: "/back" });
    expect(rate).toHaveBeenCalledWith("a-b", 4);
    expect(await replayIntent({ kind: "ban", slug: "a-b", ...base }, handlers)).toEqual({ ok: true, kind: "ban", redirectTo: "/back" });
    expect(ban).toHaveBeenCalledWith("a-b");
    expect(await replayIntent({ kind: "tested", slug: "a-b", ...base }, handlers)).toEqual({ ok: false, kind: "tested", error: "Recipe not found" });
  });

  it("does not call a handler for a value or slug out of range", async () => {
    const rate = vi.fn();
    const ban = vi.fn();
    for (const value of [0, 6, 2.5]) expect(await replayIntent({ kind: "rate", slug: "a-b", value, ...base }, { rate })).toMatchObject({ ok: false, kind: "rate" });
    expect(await replayIntent({ kind: "rate", slug: "Bad Slug", value: 3, ...base }, { rate })).toMatchObject({ ok: false });
    expect(await replayIntent({ kind: "ban", slug: "../x", ...base }, { ban })).toMatchObject({ ok: false });
    expect(rate).not.toHaveBeenCalled();
    expect(ban).not.toHaveBeenCalled();
  });

  it("reports rate, ban and tested without a handler as unsupported", async () => {
    expect(await replayIntent({ kind: "rate", slug: "a-b", value: 4, ...base }, {})).toMatchObject({ ok: false, unsupported: true });
    expect(await replayIntent({ kind: "ban", slug: "a-b", ...base }, {})).toMatchObject({ ok: false, unsupported: true });
    expect(await replayIntent({ kind: "tested", slug: "a-b", ...base }, {})).toMatchObject({ ok: false, unsupported: true });
  });

  it.each([
    [{ kind: "tick-grocery" as const, ingredient: "a-b" }],
    [{ kind: "save-profile" as const }],
  ])("reports %j as unsupported and calls nothing", async (partial) => {
    const result = await replayIntent({ ...partial, ...base }, { savePlan, favourite }, {});
    expect(result).toMatchObject({ ok: false, unsupported: true });
    expect(savePlan).not.toHaveBeenCalled();
    expect(favourite).not.toHaveBeenCalled();
  });

  it("reports missing handlers as unsupported", async () => {
    expect(await replayIntent({ kind: "favourite", slug: "a-b", ...base }, {})).toMatchObject({ ok: false, unsupported: true });
    expect(await replayIntent({ kind: "save-plan", ...base }, {}, {})).toMatchObject({ ok: false, unsupported: true });
  });
});
