import { afterEach, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { getAuth } from "../lib/auth/server";
import { verifiedSessionUser } from "../lib/auth/access";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("../lib/auth/server", () => ({ getAuth: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("gets identity from request cookies and rejects absent or unverified sessions", async () => {
  const requestHeaders = new Headers({ cookie: "synthetic-session" });
  vi.mocked(headers).mockResolvedValue(requestHeaders);
  const session = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { emailVerified: false } })
    .mockResolvedValueOnce({ user: { id: "verified", emailVerified: true } });
  vi.mocked(getAuth).mockResolvedValue({ handler: vi.fn(), api: { getSession: session } });
  await expect(verifiedSessionUser()).rejects.toThrow("Sign in");
  await expect(verifiedSessionUser()).rejects.toThrow("Verify your email");
  expect(await verifiedSessionUser()).toEqual({ id: "verified", emailVerified: true });
  expect(session).toHaveBeenCalledWith({ headers: requestHeaders });
});
