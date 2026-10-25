import { afterEach, describe, expect, it, vi } from "vitest";
import { authRequest, legacyInviteToken, safeAuthReturn } from "../lib/auth/browser";

afterEach(() => vi.unstubAllGlobals());
describe("browser auth transport", () => {
  it("uses same-origin uncached HTTP mutations and optional headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await authRequest("/sign-out", {});
    await authRequest("/sign-in/email-otp", { email: "synthetic@example.test" }, { "x-synthetic-header": "synthetic" });
    expect(fetcher).toHaveBeenLastCalledWith("/api/auth/sign-in/email-otp", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-synthetic-header": "synthetic" },
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
  it.each([null, {}, { success: false }, "success", 1])("does not redirect on an unconfirmed deletion response %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(authRequest("/delete-household-account", {})).rejects.toThrow("did not confirm account deletion");
  });
  it("requires a confirmed JSON deletion response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>failure</html>")).mockResolvedValueOnce(Response.json({ success: true })));
    await expect(authRequest("/delete-household-account", {})).rejects.toThrow("did not confirm account deletion");
    await expect(authRequest("/delete-household-account", {})).resolves.toBeUndefined();
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

describe("legacy invitation token carry-through", () => {
  it("keeps only a 43-character URL-safe token", () => {
    const token = "a".repeat(43);
    expect(legacyInviteToken(token)).toBe(token);
    for (const bad of [undefined, "", "short", `${token}x`, `${"a".repeat(42)}/`]) expect(legacyInviteToken(bad)).toBeUndefined();
  });
});
