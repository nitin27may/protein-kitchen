import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { setRecipeFeedback } from "../app/actions";
import { actionDenial, requireMember } from "../lib/auth/access";
import { getDb } from "../lib/server/context";
import { recipeIds } from "../lib/server/queries";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn(), requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/server/queries", () => ({ recipeIds: vi.fn() }));
vi.mock("../lib/human/personal-feedback", async (original) => ({
  ...await original<typeof import("../lib/human/personal-feedback")>(), writePersonalRecipeFeedback: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(actionDenial).mockResolvedValue(null);
  vi.mocked(requireMember).mockResolvedValue({ userId: "session-cook", role: "member", personId: 17 });
  vi.mocked(recipeIds).mockResolvedValue({ bySlug: new Map([["bowl", 42]]), byId: new Map([[42, "bowl"]]) });
});
describe("personal feedback action", () => {
  it("binds every valid patch to the current session profile, including owners", async () => {
    expect(await setRecipeFeedback("bowl", { rating: 5 })).toEqual({ ok: true });
    expect(writePersonalRecipeFeedback).toHaveBeenCalledWith(await getDb(), 17, 42, { rating: 5 });
    vi.mocked(requireMember).mockResolvedValue({ userId: "owner", role: "owner", personId: 19 });
    expect(await setRecipeFeedback("bowl", { favourite: true })).toEqual({ ok: true });
    expect(writePersonalRecipeFeedback).toHaveBeenLastCalledWith(await getDb(), 19, 42, { favourite: true });
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
