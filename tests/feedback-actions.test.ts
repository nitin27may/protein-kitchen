import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { setRecipeFeedback } from "../app/actions";
import { actionDenial, requireMember } from "../lib/auth/access";
import { getDb } from "../lib/server/context";
import { recipeIds } from "../lib/server/queries";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import * as s from "../lib/db/schema";
import { openDb } from "./helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/server/queries", () => ({ recipeIds: vi.fn() }));
vi.mock("../lib/human/personal-feedback", async (original) => ({
  ...await original<typeof import("../lib/human/personal-feedback")>(), writePersonalRecipeFeedback: vi.fn(),
}));
beforeEach(async () => {
  vi.resetAllMocks();
  const h = await openDb();
  vi.mocked(getDb).mockResolvedValue(h.db);
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([["a", 17], ["b", 19]].map(([householdId, id]) => ({
    id: Number(id), householdId: String(householdId), name: "Synthetic", sex: "other" as const,
    birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  })));
  await h.db.insert(s.authUsers).values(["session-cook", "owner"].map((id) => ({
    id, name: "Synthetic", email: `${id}@example.test`, emailVerified: true,
  })));
  await h.db.insert(s.householdMembers).values([
    { userId: "session-cook", householdId: "a", personId: 17, role: "member" },
    { userId: "owner", householdId: "b", personId: 19, role: "owner" },
  ]);
  vi.mocked(actionDenial).mockResolvedValue(null);
  vi.mocked(requireMember).mockResolvedValue({ userId: "session-cook", role: "member", personId: 17 });
  vi.mocked(recipeIds).mockResolvedValue({ bySlug: new Map([["bowl", 42]]), byId: new Map([[42, "bowl"]]) });
});
describe("personal feedback action", () => {
  it("binds every valid patch to the current session profile, including owners", async () => {
    expect(await setRecipeFeedback("bowl", { rating: 5 })).toEqual({ ok: true });
    expect(writePersonalRecipeFeedback).toHaveBeenCalledWith(expect.anything(), 17, 42, { rating: 5 }, "a");
    expect(vi.mocked(writePersonalRecipeFeedback).mock.calls[0]![0]).not.toBe(await getDb());
    vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: 19 });
    expect(await setRecipeFeedback("bowl", { favourite: true })).toEqual({ ok: true });
    expect(writePersonalRecipeFeedback).toHaveBeenLastCalledWith(expect.anything(), 19, 42, { favourite: true }, "b");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
  it("rejects forged author fields, malformed values and empty patches without reading recipe data", async () => {
    for (const patch of [null, {}, { personId: 99, rating: 5 }, { rating: 2.5 }, { favourite: "yes" }, { notes: "x".repeat(2001) }]) {
      expect(await Reflect.apply(setRecipeFeedback, undefined, ["bowl", patch])).toMatchObject({ ok: false });
    }
    expect(recipeIds).not.toHaveBeenCalled();
    expect(writePersonalRecipeFeedback).not.toHaveBeenCalled();
  });
  it("denies before looking up identity or data and reports missing recipes without writing", async () => {
    vi.mocked(actionDenial).mockResolvedValueOnce({ ok: false, error: "Sign in before continuing." });
    expect(await setRecipeFeedback("bowl", { favourite: true })).toEqual({ ok: false, error: "Sign in before continuing." });
    expect(requireMember).not.toHaveBeenCalled();
    expect(await setRecipeFeedback("missing", { rating: 5 })).toEqual({ ok: false, error: "Recipe not found" });
    expect(writePersonalRecipeFeedback).not.toHaveBeenCalled();
  });
});
