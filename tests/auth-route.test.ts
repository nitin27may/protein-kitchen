import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthConfigurationError } from "../lib/auth/config";
import { getAuth } from "../lib/auth/server";
import { GET, POST } from "../app/api/auth/[...all]/route";

vi.mock("../lib/auth/server", () => ({ getAuth: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });

describe("uncached auth route", () => {
  it("forwards GET and POST to the auth handler and makes responses non-cacheable", async () => {
    const handler = vi.fn<(request: Request) => Promise<Response>>()
      .mockImplementation(async () => Response.json({ success: true }));
    vi.mocked(getAuth).mockResolvedValue({ handler, api: { getSession: vi.fn() } });
    const request = new Request("http://localhost/api/auth/get-session");
    for (const method of [GET, POST]) {
      const response = await method(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it("reports missing configuration explicitly without exposing a key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAuth).mockRejectedValue(new AuthConfigurationError("Missing server configuration."));
    try {
      const response = await GET(new Request("http://localhost/api/auth/get-session"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ message: "Authentication is not configured on this instance." });
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it("does not disguise unexpected database or provider failures as a configured auth service", async () => {
    vi.mocked(getAuth).mockRejectedValue(new Error("synthetic startup failure"));
    await expect(GET(new Request("http://localhost/api/auth/get-session"))).rejects.toThrow("synthetic startup failure");
  });
});
