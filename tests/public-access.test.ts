import { afterEach, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { AccessDenied, requireMember } from "../lib/auth/access";
import { optionalPageMember } from "../lib/auth/public-access";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("../lib/auth/access", async (original) => ({
  ...await original<typeof import("../lib/auth/access")>(), requireMember: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it.each([undefined, "", "theme=dark", "fake-better-auth.session_token=spoof", "better-auth.session_data=untrusted"])(
  "serves public content without initializing auth for %s", async (cookie) => {
    vi.mocked(headers).mockResolvedValue(new Headers(cookie === undefined ? {} : { cookie }));
    expect(await optionalPageMember()).toBeNull();
    expect(requireMember).not.toHaveBeenCalled();
  },
);

it.each(["better-auth.session_token=token", "__Secure-better-auth.session_token=token", "theme=dark; better-auth.session_token=token"])(
  "uses server-authorized membership rather than trusting cookie %s", async (cookie) => {
    const incoming = new Headers({ cookie });
    const member = { userId: "verified-user", personId: 3, role: "member" as const };
    vi.mocked(headers).mockResolvedValue(incoming);
    vi.mocked(requireMember).mockResolvedValue(member);
    expect(await optionalPageMember()).toEqual(member);
    expect(requireMember).toHaveBeenCalledWith(incoming);
  },
);

it.each([401, 403] as const)("renders only public content for denied sessions (%s)", async (status) => {
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "better-auth.session_token=expired" }));
  vi.mocked(requireMember).mockRejectedValue(new AccessDenied("Denied", status));
  expect(await optionalPageMember()).toBeNull();
});

it("does not mask database/provider failures as anonymous success", async () => {
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "better-auth.session_token=token" }));
  vi.mocked(requireMember).mockRejectedValue(new Error("Database unavailable"));
  await expect(optionalPageMember()).rejects.toThrow("Database unavailable");
});
