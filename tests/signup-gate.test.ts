import { describe, expect, it } from "vitest";
import {
  ANON_TICKS_KEY, applyOutcome, beginSignup, describeReplay, intentLabel, readPendingWork, type ReplayWire,
} from "../lib/auth/signup-gate";
import {
  ANON_DRAFT_KEY, PENDING_INTENT_KEY, buildAnonDraft, loadPendingIntent, saveAnonDraft, savePendingIntent, type AnonStores, type PendingIntent, type StorageLike,
} from "../lib/plan/anon-draft";

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
const stores = () => ({ session: new FakeStorage(), local: new FakeStorage() });
const now = new Date("2026-11-02T10:00:00Z");
const setup = {
  personIds: [1], startDate: "2026-11-02", endDate: "2026-11-03", mealTypes: ["breakfast", "dinner"] as ("breakfast" | "dinner")[],
  cuisineBalance: 0.5, maxActiveMin: 20, pinned: [], prefs: { "1": { liked: [], avoided: [] } },
};
const plan = { slots: [{ date: "2026-11-02", slot: "breakfast" as const, recipeSlug: "a-one", servings: { "1": 1 }, locked: false, reasons: [] }] };
const draft = () => buildAnonDraft({ setup, seed: 5, plan, libraryVersion: "lib-1", now });

describe("beginSignup", () => {
  it("saves the intent, keeps the draft and mirrors both for an email link opened in a new tab", () => {
    const s = stores();
    saveAnonDraft(s, draft());
    const { saved } = beginSignup(s, { intent: { kind: "favourite", slug: "dal-tadka" }, returnTo: "/recipes/dal-tadka" }, now);
    expect(saved).toBe(true);
    expect(loadPendingIntent(s, now)).toMatchObject({ kind: "favourite", slug: "dal-tadka", returnTo: "/recipes/dal-tadka" });
    expect(s.local.data.has(PENDING_INTENT_KEY)).toBe(true);
    expect(s.local.data.has(ANON_DRAFT_KEY)).toBe(true);
  });

  it("makes an unsafe return address harmless", () => {
    const s = stores();
    beginSignup(s, { intent: { kind: "save-plan" }, returnTo: "//evil.example/steal" }, now);
    expect(loadPendingIntent(s, now)?.returnTo).toBe("/");
  });

  it("reports storage that refuses the write without throwing", () => {
    const blocked: StorageLike = { getItem: () => null, setItem() { throw new Error("blocked"); }, removeItem() {} };
    const s: AnonStores = { session: blocked, local: null };
    expect(beginSignup(s, { intent: { kind: "save-plan" }, returnTo: "/plan/draft" }, now).saved).toBe(false);
  });

  it("carries intents that replay cannot finish, with a label", () => {
    const s = stores();
    beginSignup(s, { intent: { kind: "other", action: "adding a link" }, returnTo: "/recipes/x" }, now);
    expect(loadPendingIntent(s, now)).toMatchObject({ kind: "other", action: "adding a link" });
  });
});

describe("readPendingWork", () => {
  it("returns nothing without an intent", () => {
    expect(readPendingWork(stores(), now)).toBeNull();
  });

  it("hands a save-plan intent its draft", () => {
    const s = stores();
    saveAnonDraft(s, draft());
    savePendingIntent(s, { kind: "save-plan", returnTo: "/plan/draft" }, now);
    const work = readPendingWork(s, now);
    expect(work).toMatchObject({ intent: { kind: "save-plan" }, draftProblem: null });
    expect(work?.draft).toEqual(draft());
  });

  it("explains a missing, expired or unreadable draft", () => {
    const missing = stores();
    savePendingIntent(missing, { kind: "save-plan", returnTo: "/plan/draft" }, now);
    expect(readPendingWork(missing, now)?.draftProblem).toMatch(/no longer on this device/);

    const expired = stores();
    saveAnonDraft(expired, draft());
    savePendingIntent(expired, { kind: "save-plan", returnTo: "/plan/draft" }, new Date(now.getTime() + 14 * 86_400_000));
    expect(readPendingWork(expired, new Date(now.getTime() + 14 * 86_400_000 + 1000))?.draftProblem).toMatch(/expired/);

    const broken = stores();
    broken.session.setItem(ANON_DRAFT_KEY, "{not json");
    savePendingIntent(broken, { kind: "save-plan", returnTo: "/plan/draft" }, now);
    expect(readPendingWork(broken, now)?.draftProblem).toMatch(/could not be read/);
  });

  it("needs no draft for other intents", () => {
    const s = stores();
    savePendingIntent(s, { kind: "favourite", slug: "dal-tadka", returnTo: "/recipes/dal-tadka" }, now);
    expect(readPendingWork(s, now)).toMatchObject({ draft: null, draftProblem: null });
  });
});

describe("describeReplay", () => {
  const intent = (over: Partial<PendingIntent> & { kind: PendingIntent["kind"] }) => ({ returnTo: "/recipes/x", createdAt: now.toISOString(), ...over }) as PendingIntent;

  it("sends a saved plan to its page and clears the device copy", () => {
    const wire: ReplayWire = { ok: true, replay: { ok: true, kind: "save-plan", redirectTo: "/plan/7", planId: 7, changed: false, libraryChanged: false } };
    expect(describeReplay(intent({ kind: "save-plan" }), wire)).toMatchObject({ status: "done", redirectTo: "/plan/7", clear: "all", message: "Plan saved to your kitchen." });
  });

  it("says when the saved plan differs from the draft", () => {
    const wire: ReplayWire = { ok: true, replay: { ok: true, kind: "save-plan", redirectTo: "/plan/7", planId: 7, changed: true } };
    expect(describeReplay(intent({ kind: "save-plan" }), wire).message).toMatch(/adjusted/);
  });

  it("returns a favourite to the recipe", () => {
    const wire: ReplayWire = { ok: true, replay: { ok: true, kind: "favourite", redirectTo: "/recipes/x" } };
    expect(describeReplay(intent({ kind: "favourite" }), wire)).toMatchObject({ status: "done", redirectTo: "/recipes/x", clear: "all" });
  });

  it("says what was saved for each replayed kind", () => {
    const ok = (kind: PendingIntent["kind"]): ReplayWire => ({ ok: true, replay: { ok: true, kind, redirectTo: "/recipes/x" } });
    expect(describeReplay(intent({ kind: "rate", value: 4 } as never), ok("rate")).message).toBe("Saved. You rated this recipe 4 out of 5.");
    expect(describeReplay(intent({ kind: "ban" }), ok("ban")).message).toBe("Saved. This recipe is hidden from your plans.");
    expect(describeReplay(intent({ kind: "tested" }), ok("tested")).message).toBe("Saved. This recipe is marked as cooked.");
    expect(describeReplay(intent({ kind: "favourite" }), ok("favourite")).message).toBe("Saved. This recipe is in your favourites.");
    expect(describeReplay(intent({ kind: "save-plan" }), { ok: true, replay: { ok: true, kind: "save-plan", redirectTo: "/plan/1" } }).message).toBe("Plan saved to your kitchen.");
  });

  it("keeps a failed rating honest", () => {
    const out = describeReplay(intent({ kind: "rate", value: 4 } as never), { ok: true, replay: { ok: false, kind: "rate", error: "Recipe not found" } });
    expect(out).toMatchObject({ status: "failed", message: "Recipe not found", clear: "intent" });
  });

  it("returns the person to the page with a clear message for an action replay cannot finish", () => {
    const wire: ReplayWire = { ok: true, replay: { ok: false, kind: "tick-grocery", error: "x", unsupported: true } };
    const out = describeReplay(intent({ kind: "tick-grocery" }), wire);
    expect(out).toMatchObject({ status: "unsupported", redirectTo: "/recipes/x", clear: "intent" });
    expect(out.message).toBe("You are signed up. Repeat ticking the grocery item from this page.");
    const other = describeReplay(intent({ kind: "other", action: "adding a link" } as never), wire);
    expect(other.message).toContain("adding a link");
  });

  it("returns to the page on a failure and keeps the plan draft", () => {
    expect(describeReplay(intent({ kind: "save-plan" }), { ok: true, replay: { ok: false, kind: "save-plan", error: "This draft has expired." } }))
      .toMatchObject({ status: "failed", redirectTo: "/recipes/x", message: "This draft has expired.", clear: "intent" });
    expect(describeReplay(intent({ kind: "save-plan" }), { ok: false, error: "Sign in before continuing." })).toMatchObject({ status: "failed", clear: "intent" });
  });

  it("names every intent kind", () => {
    for (const kind of ["save-plan", "favourite", "rate", "ban", "tested", "tick-grocery", "save-profile"] as const) expect(intentLabel({ kind })).not.toBe("");
    expect(intentLabel({ kind: "other" })).toBe("that action");
  });
});

describe("applyOutcome", () => {
  it("removes everything after success, including device ticks", () => {
    const s = stores();
    saveAnonDraft(s, draft());
    savePendingIntent(s, { kind: "save-plan", returnTo: "/plan/draft" }, now);
    s.session.setItem(ANON_TICKS_KEY, "{}");
    applyOutcome(s, { status: "done", redirectTo: "/plan/1", message: "", clear: "all" });
    expect([...s.session.data.keys(), ...s.local.data.keys()]).toEqual([]);
  });

  it("removes only the intent after a failure", () => {
    const s = stores();
    saveAnonDraft(s, draft());
    savePendingIntent(s, { kind: "save-plan", returnTo: "/plan/draft" }, now);
    applyOutcome(s, { status: "failed", redirectTo: "/plan/draft", message: "", clear: "intent" });
    expect(s.session.data.has(ANON_DRAFT_KEY)).toBe(true);
    expect(s.session.data.has(PENDING_INTENT_KEY)).toBe(false);
  });
});
