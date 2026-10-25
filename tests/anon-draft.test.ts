import { describe, expect, it } from "vitest";
import {
  ANON_DRAFT_KEY, ANON_DRAFT_VERSION, ANON_PROFILE_KEY, AnonDraftSchema, AnonProfileSchema, DRAFT_TTL_MS, INTENT_TTL_MS, MIRROR_TTL_MS,
  PENDING_INTENT_KEY, anonProfileToTarget, anonProteinTargetG, buildAnonDraft, clearAllAnonState, clearAnonDraft, draftToPlannedSlots,
  dropMirror, loadAnonDraft, loadAnonProfile, loadPendingIntent, mirrorForSignup, parsePendingIntent, planMatchesDraft, portionKey,
  saveAnonDraft, saveAnonProfile, savePendingIntent, serializePendingIntent, type AnonStores, type StorageLike,
} from "../lib/plan/anon-draft";

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
const throwing: StorageLike = {
  getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); },
};
const fresh = (): AnonStores & { session: FakeStorage; local: FakeStorage } => ({ session: new FakeStorage(), local: new FakeStorage() });

const now = new Date("2026-11-02T10:00:00Z");
const setup = {
  personIds: [1], startDate: "2026-11-02", endDate: "2026-11-03", mealTypes: ["breakfast", "dinner"] as ("breakfast" | "dinner")[],
  cuisineBalance: 0.5, maxActiveMin: 20, pinned: [], prefs: { "1": { liked: ["tofu-extra-firm"], avoided: [] } },
};
const plan = {
  slots: [
    { date: "2026-11-02", slot: "breakfast" as const, recipeSlug: "a-one", servings: { "1": 1 }, locked: false, reasons: ["x"] },
    { date: "2026-11-02", slot: "dinner" as const, recipeSlug: "b-two", servings: { "1": 1.5 }, locked: false, reasons: [], isLeftover: true },
  ],
};
const draft = () => buildAnonDraft({ setup, seed: 123, plan, libraryVersion: "lib-1", now });

describe("anonymous draft", () => {
  it("builds a schema-valid draft with defaults filled in and no reasons stored", () => {
    const d = draft();
    expect(AnonDraftSchema.parse(d)).toEqual(d);
    expect(d.setup.healthFocus).toEqual({ nutrientDense: true, lowSugar: true, light: true });
    expect(d.setup.prepStyle).toBe("leftovers");
    expect(JSON.stringify(d)).not.toContain("reasons");
    expect(d.portions[portionKey("2026-11-02", "dinner")]).toBe(1.5);
  });

  it("round-trips through session storage and back to planner slots", () => {
    const stores = fresh();
    expect(saveAnonDraft(stores, draft())).toBe(true);
    const loaded = loadAnonDraft(stores, { now, libraryVersion: "lib-1" });
    expect(loaded).toEqual({ status: "ok", draft: draft() });
    const slots = draftToPlannedSlots(draft());
    expect(slots[1]).toMatchObject({ recipeSlug: "b-two", servings: { "1": 1.5 }, isLeftover: true });
    expect(planMatchesDraft(draft(), slots, "1")).toBe(true);
    expect(stores.local.data.size).toBe(0);
  });

  it("detects a changed plan: other recipe, other portion, other count, duplicate keys", () => {
    const d = draft();
    const slots = draftToPlannedSlots(d);
    expect(planMatchesDraft(d, [{ ...slots[0]!, recipeSlug: "c-three" }, slots[1]!], "1")).toBe(false);
    expect(planMatchesDraft(d, [slots[0]!, { ...slots[1]!, servings: { "1": 2 } }], "1")).toBe(false);
    expect(planMatchesDraft(d, [slots[0]!], "1")).toBe(false);
    expect(planMatchesDraft({ ...d, slots: [d.slots[0]!, d.slots[0]!] }, [slots[0]!, slots[0]!], "1")).toBe(false);
    expect(planMatchesDraft(d, slots, "9")).toBe(false);
  });

  it("expires after 14 days and deletes the draft", () => {
    const stores = fresh();
    saveAnonDraft(stores, draft());
    const justBefore = new Date(now.getTime() + DRAFT_TTL_MS - 1);
    expect(loadAnonDraft(stores, { now: justBefore }).status).toBe("ok");
    expect(loadAnonDraft(stores, { now: new Date(now.getTime() + DRAFT_TTL_MS) }).status).toBe("expired");
    expect(stores.session.data.size).toBe(0);
    expect(loadAnonDraft(stores, { now }).status).toBe("none");
  });

  it("refuses an old format and deletes it", () => {
    const stores = fresh();
    stores.session.setItem(ANON_DRAFT_KEY, JSON.stringify({ ...draft(), version: ANON_DRAFT_VERSION + 1 }));
    expect(loadAnonDraft(stores, { now }).status).toBe("version-mismatch");
    expect(stores.session.data.size).toBe(0);
  });

  it("refuses a different library version but keeps the draft", () => {
    const stores = fresh();
    saveAnonDraft(stores, draft());
    const result = loadAnonDraft(stores, { now, libraryVersion: "lib-2" });
    expect(result).toMatchObject({ status: "library-mismatch", draft: { libraryVersion: "lib-1" } });
    expect(stores.session.data.has(ANON_DRAFT_KEY)).toBe(true);
    expect(loadAnonDraft(stores, { now }).status).toBe("ok");
  });

  it.each([
    ["not json", "{nope"],
    ["null", "null"],
    ["a string", '"x"'],
    ["unknown field", JSON.stringify({ ...draft(), birthDate: "1980-01-01" })],
    ["bad seed", JSON.stringify({ ...draft(), seed: -1 })],
    ["bad meal slot", JSON.stringify({ ...draft(), slots: [{ ...draft().slots[0], slot: "brunch" }] })],
    ["bad portion", JSON.stringify({ ...draft(), portions: { x: 0.1 } })],
    ["created far in the future", JSON.stringify({ ...draft(), createdAt: "2027-01-01T00:00:00.000Z" })],
  ])("treats %s as invalid and deletes it", (_label, raw) => {
    const stores = fresh();
    stores.session.setItem(ANON_DRAFT_KEY, raw);
    expect(loadAnonDraft(stores, { now }).status).toBe("invalid");
    expect(stores.session.data.size).toBe(0);
  });

  it("survives storage that throws or is missing", () => {
    const blocked = { session: throwing, local: throwing };
    expect(saveAnonDraft(blocked, draft())).toBe(false);
    expect(loadAnonDraft(blocked, { now }).status).toBe("none");
    expect(() => clearAnonDraft(blocked)).not.toThrow();
    expect(() => dropMirror(blocked)).not.toThrow();
    expect(mirrorForSignup({ session: null, local: null }, now)).toEqual({ draft: false, profile: false, intent: false });
    expect(saveAnonDraft({ session: null, local: null }, draft())).toBe(false);
  });

  it("mirrors to localStorage for 30 minutes so a new tab can find it, then promotes it into the session", () => {
    const first = fresh();
    saveAnonDraft(first, draft());
    saveAnonProfile(first, { protein: { mode: "fixed", grams: 120 } });
    savePendingIntent(first, { kind: "save-plan", returnTo: "/plan/new" }, now);
    expect(mirrorForSignup(first, now)).toEqual({ draft: true, profile: true, intent: true });

    const newTab = { session: new FakeStorage(), local: first.local };
    const within = new Date(now.getTime() + MIRROR_TTL_MS - 1);
    expect(loadAnonDraft(newTab, { now: within }).status).toBe("ok");
    expect(newTab.session.data.has(ANON_DRAFT_KEY)).toBe(true);
    expect(loadAnonProfile(newTab, within)?.name).toBe("You");
    expect(loadPendingIntent(newTab, within)?.kind).toBe("save-plan");

    const lateTab = { session: new FakeStorage(), local: first.local };
    const after = new Date(now.getTime() + MIRROR_TTL_MS);
    expect(loadAnonDraft(lateTab, { now: after }).status).toBe("none");
    expect(first.local.data.has(ANON_DRAFT_KEY)).toBe(false);
  });

  it("deletes a corrupt mirror and never writes a mirror when nothing is stored", () => {
    const stores = fresh();
    expect(mirrorForSignup(stores, now)).toEqual({ draft: false, profile: false, intent: false });
    stores.local.setItem(ANON_DRAFT_KEY, "garbage");
    expect(loadAnonDraft(stores, { now }).status).toBe("none");
    stores.local.setItem(ANON_DRAFT_KEY, JSON.stringify({ expiresAt: "soon", value: 1 }));
    expect(loadAnonDraft(stores, { now }).status).toBe("none");
    expect(stores.local.data.size).toBe(0);
  });

  it("clears every copy after import", () => {
    const stores = fresh();
    saveAnonDraft(stores, draft());
    saveAnonProfile(stores, { protein: { mode: "fixed", grams: 120 } });
    savePendingIntent(stores, { kind: "favourite", slug: "x-y", returnTo: "/recipes/x-y" }, now);
    mirrorForSignup(stores, now);
    clearAllAnonState(stores);
    expect(stores.session.data.size + stores.local.data.size).toBe(0);
    saveAnonDraft(stores, draft());
    mirrorForSignup(stores, now);
    dropMirror(stores);
    expect(stores.local.data.size).toBe(0);
    clearAnonDraft(stores);
    expect(stores.session.data.size).toBe(0);
  });
});

describe("anonymous profile", () => {
  it("defaults the name and accepts g/kg with weight or fixed grams", () => {
    const perKg = AnonProfileSchema.parse({ name: "  ", protein: { mode: "perKg", gPerKg: 1.2, weightKg: 70.4 }, kcalTarget: 2200 });
    expect(perKg).toMatchObject({ name: "You", kcalTarget: 2200, liked: [], avoided: [] });
    expect(anonProteinTargetG(perKg)).toBe(84);
    const fixed = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 130 }, liked: ["a-b"], avoided: ["a-b", "c-d"] });
    expect(fixed.kcalTarget).toBeNull();
    const target = anonProfileToTarget(fixed);
    expect(target).toMatchObject({ id: "1", name: "You", proteinTargetG: 130, kcalTarget: null });
    expect([...target.liked]).toEqual([]);
    expect([...target.avoided]).toEqual(["a-b", "c-d"]);
  });

  it.each(["birthDate", "sex", "heightCm", "activityLevel"])("rejects %s", (field) => {
    expect(AnonProfileSchema.safeParse({ protein: { mode: "fixed", grams: 120 }, [field]: "x" }).success).toBe(false);
  });

  it("rejects out-of-range protein and calories, and drops a corrupt stored profile", () => {
    expect(AnonProfileSchema.safeParse({ protein: { mode: "fixed", grams: 10 } }).success).toBe(false);
    expect(AnonProfileSchema.safeParse({ protein: { mode: "perKg", gPerKg: 9, weightKg: 70 } }).success).toBe(false);
    expect(AnonProfileSchema.safeParse({ protein: { mode: "fixed", grams: 120 }, kcalTarget: 10 }).success).toBe(false);
    const stores = fresh();
    stores.session.setItem(ANON_PROFILE_KEY, '{"protein":{}}');
    expect(loadAnonProfile(stores, now)).toBeNull();
    expect(stores.session.data.size).toBe(0);
    stores.session.setItem(ANON_PROFILE_KEY, "{bad");
    expect(loadAnonProfile(stores, now)).toBeNull();
    expect(loadAnonProfile(stores, now)).toBeNull();
  });
});

describe("pending intent", () => {
  const at = now.toISOString();
  it("serializes every kind and parses it back", () => {
    for (const input of [
      { kind: "save-plan" as const, returnTo: "/plan/new" },
      { kind: "favourite" as const, slug: "falafel-bowl", returnTo: "/recipes/falafel-bowl" },
      { kind: "rate" as const, slug: "falafel-bowl", value: 4, returnTo: "/recipes/falafel-bowl?x=1#top" },
      { kind: "ban" as const, slug: "falafel-bowl", returnTo: "/" },
      { kind: "tested" as const, slug: "falafel-bowl", returnTo: "/" },
      { kind: "tick-grocery" as const, ingredient: "tofu-extra-firm", returnTo: "/groceries" },
      { kind: "save-profile" as const, returnTo: "/profiles" },
    ]) {
      expect(parsePendingIntent(serializePendingIntent(input, now), now)).toEqual({ ...input, createdAt: at });
    }
  });

  it.each([
    ["//evil.example/x", "/"],
    ["https://evil.example", "/"],
    ["/\\evil", "/"],
    ["javascript:alert(1)", "/"],
    ["/sign-in?next=/x", "/"],
    ["/onboarding", "/"],
    ["", "/"],
  ])("only keeps same-origin relative returnTo (%s)", (returnTo, expected) => {
    expect(parsePendingIntent(serializePendingIntent({ kind: "save-plan", returnTo }, now), now)?.returnTo).toBe(expected);
  });

  it("rejects bad shapes, bad values and old intents", () => {
    expect(parsePendingIntent("{bad", now)).toBeNull();
    expect(parsePendingIntent({ kind: "rate", slug: "a-b", value: 6, returnTo: "/", createdAt: at }, now)).toBeNull();
    expect(parsePendingIntent({ kind: "favourite", slug: "Bad Slug", returnTo: "/", createdAt: at }, now)).toBeNull();
    expect(parsePendingIntent({ kind: "delete-everything", returnTo: "/", createdAt: at }, now)).toBeNull();
    expect(parsePendingIntent({ kind: "save-plan", returnTo: "/", createdAt: at, extra: 1 }, now)).toBeNull();
    const raw = serializePendingIntent({ kind: "save-plan", returnTo: "/" }, now);
    expect(parsePendingIntent(raw, new Date(now.getTime() + INTENT_TTL_MS))).toBeNull();
    expect(parsePendingIntent(raw, new Date(now.getTime() - 3_600_000))).toBeNull();
    expect(() => serializePendingIntent({ kind: "rate", slug: "a-b", value: 0, returnTo: "/" }, now)).toThrow();
  });

  it("stores in the session, drops expired or corrupt values", () => {
    const stores = fresh();
    expect(loadPendingIntent(stores, now)).toBeNull();
    expect(savePendingIntent(stores, { kind: "save-plan", returnTo: "/" }, now)).toBe(true);
    expect(loadPendingIntent(stores, now)?.kind).toBe("save-plan");
    expect(loadPendingIntent(stores, new Date(now.getTime() + INTENT_TTL_MS))).toBeNull();
    expect(stores.session.data.has(PENDING_INTENT_KEY)).toBe(false);
  });
});
