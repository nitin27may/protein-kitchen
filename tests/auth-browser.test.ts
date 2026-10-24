import { afterEach, describe, expect, it, vi } from "vitest";
import { authRequest, safeAuthReturn } from "../lib/auth/browser";

afterEach(() => vi.unstubAllGlobals());
describe("browser auth transport", () => {
  it("uses same-origin uncached HTTP mutations and optional admission headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await authRequest("/sign-out", {});
    await authRequest("/sign-up/email", { email: "synthetic@example.test" }, { "x-household-invitation": "synthetic" });
    expect(fetcher).toHaveBeenLastCalledWith("/api/auth/sign-up/email", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-household-invitation": "synthetic" },
      body: '{"email":"synthetic@example.test"}',
    });
  });
  it.each([
    [400, { message: "Wrong code." }, "Wrong code."],
    [429, { message: "provider limit" }, "Too many attempts"],
    [503, { unexpected: true }, "Authentication failed"],
    [500, { message: 123 }, "Authentication failed"],
    [500, null, "Authentication failed"],
  ])("surfaces status %s without assuming an error shape", async (status, body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
    await expect(authRequest("/sign-out", {})).rejects.toThrow(message);
  });
  it("handles non-JSON errors and unavailable networks explicitly", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("not JSON", { status: 503 }))
      .mockRejectedValueOnce(new Error("synthetic network failure"));
    vi.stubGlobal("fetch", fetcher);
    await expect(authRequest("/sign-out", {})).rejects.toThrow("Authentication failed");
    await expect(authRequest("/sign-out", {})).rejects.toThrow("Check your connection");
  });
});
describe("safe local auth return paths", () => {
  it("rejects repeated or non-string query input", () => {
    expect(Reflect.apply(safeAuthReturn, null, [["/groceries", "/account"]])).toBe("/");
  });
  it.each([undefined, "", "https://outside.example", "//outside.example", "/\\outside.example", "/\nelsewhere",
    "/sign-in", "/sign-up?next=/plan/1", "/verify-email", "/reset-password", "/onboarding"])("rejects %s", (value) => {
    expect(safeAuthReturn(value)).toBe("/");
  });
  it.each(["/plan/300?view=week", "/groceries", "/recipes/tofu#steps", "/account"])("preserves %s", (value) => {
    expect(safeAuthReturn(value)).toBe(value);
  });
});
