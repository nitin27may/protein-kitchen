import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { actionDenial } from "../lib/auth/access";
import { getDb, getData } from "../lib/server/context";
import * as actions from "../app/actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));
const denied = { ok: false as const, error: "Sign in before continuing." };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(actionDenial).mockResolvedValue(denied);
});
afterEach(() => vi.unstubAllEnvs());
describe("every exported legacy server action denies before reading data or producing side effects", () => {
  it.each(Object.entries(actions))("%s", async (_name, action) => {
    expect(typeof action).toBe("function");
    expect(await Reflect.apply(action, undefined, [])).toEqual(denied);
    expect(actionDenial).toHaveBeenCalledOnce();
    expect(getDb).not.toHaveBeenCalled();
    expect(getData).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  describe("preview photo mutation boundaries", () => {
    it.each(["uploadRecipePhoto", "removePhoto", "makeCoverPhoto"] as const)("%s refuses before data, image or blob work", async (name) => {
      vi.mocked(actionDenial).mockResolvedValue(null);
      vi.stubEnv("VERCEL_ENV", "preview");
      expect(await Reflect.apply(actions[name], undefined, [])).toEqual({ ok: false, error: "Photo changes are disabled in preview deployments." });
      expect(getDb).not.toHaveBeenCalled();
      expect(getData).not.toHaveBeenCalled();
    });
  });
});
