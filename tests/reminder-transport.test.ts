import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sendPush, syntheticPushTarget } from "../lib/reminders/transport";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
const env = {
  NODE_ENV: "development", DATABASE_ENV: "development", AUTH_TEST_MAILBOX: "1",
  DATABASE_URL: "postgres://fixture@127.0.0.1:54329/protein_kitchen_e2e",
  REMINDER_TEST_PUSH_URL: "http://127.0.0.1:32111", REMINDER_TEST_PUSH_SECRET: "synthetic-push-fixture-secret-for-tests",
};
const registration = { endpoint: "https://push.example.test/device", p256dh: "synthetic-p256dh-key", auth: "synthetic-auth-key" };
const payload = { title: "Synthetic test", body: "Synthetic prep", url: "/" };
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 201 }))); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("synthetic transport boundary", () => {
  it("uses only the explicit disposable local fixture", async () => {
    expect(syntheticPushTarget(env)).toEqual({ endpoint: env.REMINDER_TEST_PUSH_URL, secret: env.REMINDER_TEST_PUSH_SECRET });
    await sendPush(registration, payload, env);
    expect(fetch).toHaveBeenCalledWith(env.REMINDER_TEST_PUSH_URL, expect.objectContaining({
      method: "POST", redirect: "error", headers: expect.objectContaining({ authorization: `Bearer ${env.REMINDER_TEST_PUSH_SECRET}` }),
      body: JSON.stringify({ device: "/device", payload }),
    }));
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
  it.each([
    { NODE_ENV: "production" }, { DATABASE_ENV: "production" }, { AUTH_TEST_MAILBOX: "" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" },
    { DATABASE_URL: undefined }, { DATABASE_URL: "" }, { DATABASE_URL: "postgres://fixture@127.0.0.1/real_household" },
    { DATABASE_URL: "postgres://fixture@db.example.test/protein_kitchen_e2e?sslmode=verify-full" },
    { REMINDER_TEST_PUSH_URL: "" }, { REMINDER_TEST_PUSH_URL: "https://127.0.0.1:32111" },
    { REMINDER_TEST_PUSH_URL: "http://localhost:32111" }, { REMINDER_TEST_PUSH_URL: "http://127.0.0.1" },
    { REMINDER_TEST_PUSH_URL: "http://127.0.0.1:32111/path" }, { REMINDER_TEST_PUSH_URL: "http://127.0.0.1:32111/?x=1" },
    { REMINDER_TEST_PUSH_URL: "http://127.0.0.1:32111/#fragment" }, { REMINDER_TEST_PUSH_URL: "http://user@127.0.0.1:32111" },
    { REMINDER_TEST_PUSH_URL: "http://user:synthetic@127.0.0.1:32111" },
    { REMINDER_TEST_PUSH_SECRET: "" }, { REMINDER_TEST_PUSH_SECRET: "short" },
  ])("refuses unsafe fixture configuration: %j", async (override) => {
    await expect(sendPush(registration, payload, { ...env, ...override })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
  it.each([
    { endpoint: "https://real-provider.example.test/household" }, { endpoint: "https://user@push.example.test/device" },
    { endpoint: "https://user:synthetic@push.example.test/device" }, { p256dh: "real-key" }, { auth: "real-auth" },
  ])("refuses a non-synthetic registration: %j", async (override) => {
    await expect(sendPush({ ...registration, ...override }, payload, env)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([429, 503, 410, 500])("preserves explicit provider status %i for safe receipt classification", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    await expect(sendPush(registration, payload, env)).rejects.toMatchObject({ statusCode: status });
  });
  it("uses the existing real web-push contract only without a fixture override", async () => {
    expect(() => syntheticPushTarget({ ...env, REMINDER_TEST_PUSH_URL: undefined })).toThrow();
    await sendPush(registration, payload, {});
    expect(fetch).not.toHaveBeenCalled();
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: registration.endpoint, keys: { p256dh: registration.p256dh, auth: registration.auth } },
      JSON.stringify(payload), { TTL: 21600, timeout: 10000 },
    );
  });
  it("propagates a fixture network failure without falling back to a real provider", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Synthetic network failure"));
    await expect(sendPush(registration, payload, env)).rejects.toThrow("Synthetic network failure");
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
