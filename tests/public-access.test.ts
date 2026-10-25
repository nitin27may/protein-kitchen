import { afterEach, describe, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { AccessDenied, requireMember } from "../lib/auth/access";
import { optionalPageMember, shellAccount } from "../lib/auth/public-access";

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

describe("shellAccount", () => {
  it.each([undefined, "theme=dark", "fake-better-auth.session_token=spoof"])("is a visitor without touching auth for %s", async (cookie) => {
    vi.mocked(headers).mockResolvedValue(new Headers(cookie === undefined ? {} : { cookie }));
    expect(await shellAccount()).toEqual({ kind: "visitor" });
    expect(requireMember).not.toHaveBeenCalled();
  });

  it("returns the member when the session is authorised", async () => {
    const member = { userId: "verified-user", personId: 3, role: "member" as const };
    vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "better-auth.session_token=token" }));
    vi.mocked(requireMember).mockResolvedValue(member);
    expect(await shellAccount()).toEqual({ kind: "member", member });
  });

  it("treats an expired session (401) as a visitor", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "better-auth.session_token=expired" }));
    vi.mocked(requireMember).mockRejectedValue(new AccessDenied("Expired", 401));
    expect(await shellAccount()).toEqual({ kind: "visitor" });
  });

  it("treats a session without a finished profile (403) as setup", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "__Secure-better-auth.session_token=token" }));
    vi.mocked(requireMember).mockRejectedValue(new AccessDenied("Finish your profile", 403));
    expect(await shellAccount()).toEqual({ kind: "setup" });
  });

  it("does not mask other failures", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ cookie: "better-auth.session_token=token" }));
    vi.mocked(requireMember).mockRejectedValue(new Error("Database unavailable"));
    await expect(shellAccount()).rejects.toThrow("Database unavailable");
  });
});
