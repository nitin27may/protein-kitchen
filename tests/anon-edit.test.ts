import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { AnonProfileSchema, portionKey } from "../lib/plan/anon-draft";
import {
  draftDays, draftSwapOptions, enableDraftShake, regenerateDraft, setDraftPortion, swapDraftSlot, toggleDraftLock,
} from "../lib/plan/anon-edit";
import { generateAnonPlan } from "../lib/plan/anon-generate";
import { deviceGroceryLines } from "../lib/plan/anon-groceries";
import { hydrateAnonLibrary } from "../lib/plan/anon-library";
import { formToProfile, profileToForm, DEFAULT_ANON_FORM } from "../lib/plan/anon-profile-form";
import { draftScreen } from "../lib/plan/draft-state";
import { anonLibrary } from "../lib/server/anon-library";

const data = loadData(process.cwd());
const library = hydrateAnonLibrary(JSON.parse(anonLibrary(data).body));
const now = new Date("2026-11-02T10:00:00Z");
const profile = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 110 } });
const setup = {
  personIds: [1], startDate: "2026-11-02", endDate: "2026-11-05", mealTypes: ["breakfast", "lunch", "dinner"] as ("breakfast" | "lunch" | "dinner")[],
  cuisineBalance: 0.5, maxActiveMin: null, pinned: [], prefs: { "1": { liked: [], avoided: [] } },
};
const made = generateAnonPlan({ setup, profile, library, seed: 99, now });
if (!made.ok) throw new Error(made.error);
const draft = made.draft;
const first = { date: draft.slots[0]!.date, slot: draft.slots[0]!.slot };

describe("device draft edits", () => {
  it("suggests swaps that differ from the current meal and fit the slot", () => {
    const options = draftSwapOptions(draft, profile, library, first);
    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.slug)).not.toContain(draft.slots[0]!.recipeSlug);
    for (const o of options) expect(library.candidates.find((c) => c.slug === o.slug)!.mealSlots).toContain(first.slot);
  });

  it("swaps a meal, keeps the lock and sizes the new portion", () => {
    const pick = draftSwapOptions(draft, profile, library, first)[0]!;
    const edit = swapDraftSlot(draft, profile, library, first, pick.slug);
    if (!edit.ok) throw new Error(edit.error);
    expect(edit.draft.slots[0]).toMatchObject({ recipeSlug: pick.slug, locked: false });
    expect(edit.draft.portions[portionKey(first.date, first.slot)]).toBeGreaterThanOrEqual(0.25);
    expect(edit.draft.slots.slice(1)).toEqual(draft.slots.slice(1));
    expect(draft.slots[0]!.recipeSlug).not.toBe(pick.slug);
  });

  it("refuses a swap to an unknown recipe or an unknown meal", () => {
    expect(swapDraftSlot(draft, profile, library, first, "not-a-recipe")).toMatchObject({ ok: false });
    expect(swapDraftSlot(draft, profile, library, { date: "2030-01-01", slot: "lunch" }, draft.slots[0]!.recipeSlug)).toMatchObject({ ok: false });
  });

  it("locks and unlocks", () => {
    const locked = toggleDraftLock(draft, first, true);
    if (!locked.ok) throw new Error(locked.error);
    expect(locked.draft.slots[0]!.locked).toBe(true);
    const unlocked = toggleDraftLock(locked.draft, first, false);
    expect(unlocked.ok && unlocked.draft.slots[0]!.locked).toBe(false);
    expect(toggleDraftLock(draft, { date: "2030-01-01", slot: "lunch" }, true)).toMatchObject({ ok: false });
  });

  it("changes a portion in quarter servings within limits", () => {
    const edit = setDraftPortion(draft, first, 1.6);
    if (!edit.ok) throw new Error(edit.error);
    expect(edit.draft.portions[portionKey(first.date, first.slot)]).toBe(1.5);
    expect(setDraftPortion(draft, first, 0.1)).toMatchObject({ ok: false });
    expect(setDraftPortion(draft, first, 4.5)).toMatchObject({ ok: false });
    expect(setDraftPortion(draft, first, Number.NaN)).toMatchObject({ ok: false });
    expect(setDraftPortion(draft, { date: "2030-01-01", slot: "lunch" }, 1)).toMatchObject({ ok: false });
  });

  it("regenerates with a new seed and keeps locked meals", () => {
    const locked = toggleDraftLock(draft, first, true);
    if (!locked.ok) throw new Error(locked.error);
    const again = regenerateDraft(locked.draft, profile, library, 424242, now);
    if (!again.ok) throw new Error(again.error);
    expect(again.draft.seed).toBe(424242);
    expect(again.draft.slots.find((s) => s.date === first.date && s.slot === first.slot)).toMatchObject({ recipeSlug: draft.slots[0]!.recipeSlug, locked: true });
    expect(again.draft.slots.map((s) => s.recipeSlug)).not.toEqual(draft.slots.map((s) => s.recipeSlug));
  });

  it("adds a shake once", () => {
    const withShake = enableDraftShake(draft, profile, library, 7, now);
    if (!withShake.ok) throw new Error(withShake.error);
    expect(withShake.draft.setup.mealTypes).toContain("shake");
    expect(withShake.draft.slots.some((s) => s.slot === "shake")).toBe(true);
    expect(enableDraftShake(withShake.draft, profile, library, 8, now)).toEqual({ ok: true, draft: withShake.draft });
  });

  it("totals protein per day against the target", () => {
    const { days, slots } = draftDays(draft, profile, library);
    expect(slots).toHaveLength(draft.slots.length);
    expect(days).toHaveLength(4);
    for (const d of days) expect(d.proteinTargetG).toBe(110);
  });

  it("builds a grocery list from the device copy only", () => {
    const { lines } = deviceGroceryLines(draft, library);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((l) => l.recipes.length > 0)).toBe(true);
  });
});

describe("device profile form", () => {
  it("accepts per-kilogram and fixed targets", () => {
    const a = formToProfile({ ...DEFAULT_ANON_FORM, weightKg: "75" });
    expect(a).toMatchObject({ ok: true, profile: { name: "You", protein: { mode: "perKg", gPerKg: 1.2, weightKg: 75 }, kcalTarget: null } });
    const b = formToProfile({ ...DEFAULT_ANON_FORM, mode: "fixed", grams: "120", kcal: "2200", name: " Asha " }, { liked: ["paneer"], avoided: ["Bad Slug", "tofu-extra-firm"] });
    expect(b).toMatchObject({ ok: true, profile: { name: "Asha", protein: { mode: "fixed", grams: 120 }, kcalTarget: 2200, liked: ["paneer"], avoided: ["tofu-extra-firm"] } });
  });

  it("reports each field that is wrong", () => {
    expect(formToProfile(DEFAULT_ANON_FORM)).toMatchObject({ ok: false, errors: { weightKg: expect.any(String) } });
    expect(formToProfile({ ...DEFAULT_ANON_FORM, gPerKg: "9", weightKg: "20", kcal: "12" })).toMatchObject({ ok: false, errors: { gPerKg: expect.any(String), weightKg: expect.any(String), kcal: expect.any(String) } });
    expect(formToProfile({ ...DEFAULT_ANON_FORM, mode: "fixed", grams: "12.5" })).toMatchObject({ ok: false, errors: { grams: expect.any(String) } });
    expect(formToProfile({ ...DEFAULT_ANON_FORM, mode: "fixed", grams: "abc" })).toMatchObject({ ok: false });
  });

  it("round-trips a stored profile back into the form", () => {
    const stored = AnonProfileSchema.parse({ name: "Asha", protein: { mode: "perKg", gPerKg: 1.4, weightKg: 80 }, kcalTarget: 2300 });
    expect(profileToForm(stored)).toEqual({ name: "Asha", mode: "perKg", gPerKg: "1.4", weightKg: "80", grams: "", kcal: "2300" });
    expect(profileToForm(profile)).toMatchObject({ name: "", mode: "fixed", grams: "110", weightKg: "" });
  });
});

describe("draft page states", () => {
  const ok = { status: "ok" as const, draft };
  it("shows the plan when the draft, profile and library are usable", () => {
    expect(draftScreen(ok, profile, library)).toEqual({ kind: "plan", draft, warning: null });
  });
  it("waits while storage or the library is loading", () => {
    expect(draftScreen({ status: "loading" }, null, null)).toBeNull();
    expect(draftScreen(ok, profile, null)).toBeNull();
  });
  it.each([["none", /No plan on this device/], ["expired", /expired/], ["invalid", /could not be read/], ["version-mismatch", /older version/]] as const)(
    "explains %s and offers a restart", (status, title) => {
      const screen = draftScreen({ status }, profile, library);
      expect(screen).toMatchObject({ kind: "message", primary: "restart" });
      expect(screen && screen.kind === "message" ? screen.title : "").toMatch(title);
    });
  it("asks to start again when the profile is missing", () => {
    expect(draftScreen(ok, null, library)).toMatchObject({ kind: "message", title: "Your profile is missing" });
  });
  it("keeps the plan with a warning when only the library version changed", () => {
    const screen = draftScreen({ status: "library-mismatch", draft }, profile, library);
    expect(screen).toMatchObject({ kind: "plan", draft });
    expect(screen && screen.kind === "plan" ? screen.warning : null).toMatch(/updated/);
  });
  it("refuses a plan that names a recipe the library no longer has", () => {
    const broken = { ...draft, slots: draft.slots.map((s, i) => (i === 0 ? { ...s, recipeSlug: "gone-recipe" } : s)) };
    expect(draftScreen({ status: "library-mismatch", draft: broken }, profile, library)).toMatchObject({ kind: "message", title: "The recipe library changed" });
    expect(draftScreen({ status: "ok", draft: broken }, profile, library)).toMatchObject({ kind: "message", primary: "regenerate" });
  });
});
