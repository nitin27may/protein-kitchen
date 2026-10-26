import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db/client";
import { getDb } from "../lib/server/context";
import { createAuth } from "../lib/auth/create";
import { resendAuthSender } from "../lib/auth/mail";
import { localTestAuthSender } from "../lib/auth/test-mail";
import { limitedSender } from "../lib/auth/mail-limits";

vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/auth/create", () => ({ createAuth: vi.fn() }));
vi.mock("../lib/auth/mail", () => ({ resendAuthSender: vi.fn() }));
vi.mock("../lib/auth/test-mail", () => ({ localTestAuthSender: vi.fn() }));
vi.mock("../lib/auth/mail-limits", () => ({ limitedSender: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  // The limiter is covered in mail-limits.test.ts; here it passes the transport through and records its options.
  vi.mocked(limitedSender).mockImplementation((_db, _options, send) => send);
  vi.stubEnv("BETTER_AUTH_URL", "https://kitchen.example.test");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-session-secret-for-tests-only");
  vi.stubEnv("AUTH_TEST_MAILBOX", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("lazy server auth initialization", () => {
  it("does not open a database on import and caches the configured provider after first use", async () => {
    const { getAuth, sendHouseholdAssociationNotice } = await import("../lib/auth/server");
    expect(getDb).not.toHaveBeenCalled();
    const db: Db = Object.create(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const sendCode = vi.fn<(mail: import("../lib/auth/create").AuthMail) => Promise<void>>().mockResolvedValue();
    vi.mocked(resendAuthSender).mockReturnValue(sendCode);
    const provider = { handler: vi.fn<(request: Request) => Promise<Response>>(), api: { getSession: vi.fn(), setPassword: vi.fn(), changePassword: vi.fn() } };
    vi.mocked(createAuth).mockReturnValue(provider);
    expect(await getAuth()).toBe(provider);
    expect(await getAuth()).toBe(provider);
    await sendHouseholdAssociationNotice("synthetic-recipient@example.test");
    expect(getDb).toHaveBeenCalledOnce();
    expect(limitedSender).toHaveBeenCalledWith(db, { secret: "synthetic-session-secret-for-tests-only", dailyCap: 60, allowlist: null }, sendCode);
    expect(createAuth).toHaveBeenCalledWith(db, expect.objectContaining({ sendCode, sendLink: sendCode, baseURL: "https://kitchen.example.test" }));
    expect(sendCode).toHaveBeenCalledWith({
      email: "synthetic-recipient@example.test",
      url: "https://kitchen.example.test/sign-in",
      type: "household-association",
    });
  });
  it("does not open a pool on missing configuration and retries a failed startup", async () => {
    const { getAuth } = await import("../lib/auth/server");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    await expect(getAuth()).rejects.toThrow("BETTER_AUTH_SECRET");
    expect(getDb).not.toHaveBeenCalled();
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-session-secret-for-tests-only");
    vi.mocked(resendAuthSender).mockReturnValue(async () => {});
    vi.mocked(getDb).mockRejectedValueOnce(new Error("synthetic database startup failure"));
    await expect(getAuth()).rejects.toThrow("synthetic database startup failure");
    const db: Db = Object.create(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const provider = { handler: vi.fn<(request: Request) => Promise<Response>>(), api: { getSession: vi.fn(), setPassword: vi.fn(), changePassword: vi.fn() } };
    vi.mocked(createAuth).mockReturnValue(provider);
    expect(await getAuth()).toBe(provider);
  });
  it("only chooses the test transport when explicitly requested and never falls back to it", async () => {
    const { getAuth } = await import("../lib/auth/server");
    vi.stubEnv("AUTH_TEST_MAILBOX", "1");
    const db: Db = Object.create(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const send = async () => {};
    vi.mocked(localTestAuthSender).mockReturnValue(send);
    const provider = { handler: vi.fn<(request: Request) => Promise<Response>>(), api: { getSession: vi.fn(), setPassword: vi.fn(), changePassword: vi.fn() } };
    vi.mocked(createAuth).mockReturnValue(provider);
    expect(await getAuth()).toBe(provider);
    expect(resendAuthSender).not.toHaveBeenCalled();
    expect(createAuth).toHaveBeenCalledWith(db, expect.objectContaining({ sendCode: send, sendLink: send }));
  });
});
