import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/reminders/route";
import { dispatchReminders, vapidConfigured } from "../lib/server/push";
import { hasSchedulerPayload } from "../lib/server/scheduler";

vi.mock("../lib/server/push", () => ({ dispatchReminders: vi.fn(), vapidConfigured: vi.fn() }));
const secret = "synthetic-reminder-scheduler-secret-123";
const req = (options: { auth?: string | null; query?: string; body?: string } = {}) => new Request(`https://kitchen.example.test/api/reminders${options.query ?? ""}`, {
  method: "POST", headers: options.auth === null ? {} : { authorization: options.auth ?? `Bearer ${secret}` }, body: options.body,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("REMINDER_SCHEDULER_ENABLED", "true");
  vi.stubEnv("REMINDER_SCHEDULER_SECRET", secret);
  vi.mocked(vapidConfigured).mockReturnValue(true);
  vi.mocked(dispatchReminders).mockResolvedValue({ sent: 2, retry: 0, ambiguous: 0, cancelled: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("explicitly enabled private reminder scheduling", () => {
  it.each(["disabled", "preview", "missing-secret", "short-secret"])("refuses %s without database/provider access", async (kind) => {
    if (kind === "disabled") vi.stubEnv("REMINDER_SCHEDULER_ENABLED", "false");
    if (kind === "preview") vi.stubEnv("VERCEL_ENV", "preview");
    if (kind === "missing-secret") vi.stubEnv("REMINDER_SCHEDULER_SECRET", "");
    if (kind === "short-secret") vi.stubEnv("REMINDER_SCHEDULER_SECRET", "short");
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it.each([null, "Bearer state-sync-secret-which-is-not-reminders", "Basic invalid", `bearer ${secret}`, `Bearer ${"x".repeat(secret.length)}`])(
    "rejects missing/wrong/cross-purpose credential", async (auth) => {
      const response = await POST(req({ auth }));
      expect(response.status).toBe(401);
      expect(dispatchReminders).not.toHaveBeenCalled();
    },
  );
  it.each(["STATE_SYNC_SCHEDULER_SECRET", "BETTER_AUTH_SECRET", "VAPID_PRIVATE_KEY"])("refuses a reused %s credential", async (key) => {
    vi.stubEnv(key, secret);
    expect((await POST(req())).status).toBe(503);
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it.each([{ query: "?personId=1" }, { query: "?now=2099-01-01" }, { body: "{}" }, { body: " " }])("rejects request-controlled inputs: %j", async (options) => {
    expect((await POST(req(options))).status).toBe(400);
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it("refuses provider-disabled configuration and returns a safe message", async () => {
    vi.mocked(vapidConfigured).mockReturnValue(false);
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Reminders are not configured." });
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it.each([undefined, ""])("accepts an actually empty POST and returns only aggregate results", async (body) => {
    const response = await POST(req({ body }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, sent: 2, retry: 0, ambiguous: 0, cancelled: 0 });
    expect(dispatchReminders).toHaveBeenCalledWith();
  });
  it.each(["retry", "ambiguous"] as const)("reports explicit %s outcomes rather than delivery-shaped success", async (status) => {
    vi.mocked(dispatchReminders).mockResolvedValue({ sent: 1, retry: 0, ambiguous: 0, cancelled: 0, [status]: 1 });
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, sent: 1, [status]: 1 });
  });
  it("sanitizes database/provider exceptions without private logs", async () => {
    vi.mocked(dispatchReminders).mockRejectedValue(new Error("PRIVATE_TASK_ENDPOINT_CREDENTIAL"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_TASK_ENDPOINT_CREDENTIAL");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_TASK_ENDPOINT_CREDENTIAL");
  });
  it("returns a sanitized error on body-stream failure before dispatch", async () => {
    const request = req();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.error(new Error("PRIVATE_BODY")); } });
    vi.spyOn(request, "body", "get").mockReturnValue(stream);
    expect((await POST(request)).status).toBe(503);
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it("bounds a stalled empty body read and cancels the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
    const request = req();
    vi.spyOn(request, "body", "get").mockReturnValue(stream);
    const response = POST(request);
    await vi.advanceTimersByTimeAsync(2001);
    expect((await response).status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispatchReminders).not.toHaveBeenCalled();
  });
  it("bounds streams made only of empty chunks", async () => {
    const request = req();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array()); } });
    vi.spyOn(request, "body", "get").mockReturnValue(stream);
    expect(await hasSchedulerPayload(request)).toBe(true);
  });
});
