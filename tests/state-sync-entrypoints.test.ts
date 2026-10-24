import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { actionDenial } from "../lib/auth/access";
import { StateSyncConfigurationError, schedulerAuthorized, stateSyncConfiguration } from "../lib/sync/config";
import { configuredStateSync } from "../lib/sync/server";
import { syncSharedState } from "../app/settings/sync-actions";
import { POST } from "../app/api/state-sync/route";
import { fixtureConfiguration as config } from "./helpers/github-state";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ actionDenial: vi.fn() }));
vi.mock("../lib/sync/server", () => ({ configuredStateSync: vi.fn() }));
const secret = "synthetic-scheduler-secret-for-tests-123";
const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
const configEnv = {
  STATE_SYNC_ENABLED: "true", STATE_SYNC_CLASSES: "saved-views, recipe-links", STATE_SYNC_HOUSEHOLD_ID: "a",
  STATE_GITHUB_APP_ID: String(config.appId), STATE_GITHUB_INSTALLATION_ID: String(config.installationId),
  STATE_GITHUB_REPOSITORY_ID: String(config.repositoryId), STATE_GITHUB_OWNER: config.owner,
  STATE_GITHUB_REPOSITORY: config.repository, STATE_GITHUB_BRANCH: config.branch, STATE_GITHUB_PRIVATE_KEY: config.privateKey,
};
const req = (options: { auth?: string | null; key?: string | null; query?: string; body?: string } = {}) => new Request(`https://kitchen.example.test/api/state-sync${options.query ?? ""}`, {
  method: "POST", headers: {
    ...(options.auth === null ? {} : { authorization: options.auth ?? `Bearer ${secret}` }),
    ...(options.key === null ? {} : { "idempotency-key": options.key ?? uuid }),
  }, body: options.body,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("STATE_SYNC_SCHEDULER_SECRET", secret);
  vi.mocked(actionDenial).mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("explicit configuration and scheduler authentication", () => {
  it("requires explicit shared class consent and pins the immutable target identity", () => {
    expect(stateSyncConfiguration(configEnv)).toMatchObject({ github: config, classes: ["recipe-links", "saved-views"], targetKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
    for (const value of [undefined, "", "people", "saved-views,saved-views", "saved-views,photos,people"]) {
      expect(() => stateSyncConfiguration({ ...configEnv, STATE_SYNC_CLASSES: value })).toThrow(StateSyncConfigurationError);
    }
    for (const override of [{ STATE_SYNC_ENABLED: "false" }, { STATE_GITHUB_REPOSITORY_ID: "" }, { VERCEL_ENV: "preview" }]) {
      expect(() => stateSyncConfiguration({ ...configEnv, ...override })).toThrow(StateSyncConfigurationError);
    }
    for (const householdId of [undefined, "", "bad household", "../other"]) {
      expect(() => stateSyncConfiguration({ ...configEnv, STATE_SYNC_HOUSEHOLD_ID: householdId })).toThrow(StateSyncConfigurationError);
    }
    expect(stateSyncConfiguration({ ...configEnv, STATE_SYNC_HOUSEHOLD_ID: "b" }).targetKey).not.toBe(stateSyncConfiguration(configEnv).targetKey);
  });
  it.each([undefined, "", "short", "a".repeat(129), "x".repeat(31), " ".repeat(40)])("disables missing or invalid scheduler credentials: %s", (value) => {
    expect(schedulerAuthorized(req(), { STATE_SYNC_SCHEDULER_SECRET: value })).toBe("disabled");
  });
  it("refuses preview and malformed/missing/wrong bearer credentials", () => {
    expect(schedulerAuthorized(req(), { STATE_SYNC_SCHEDULER_SECRET: secret, VERCEL_ENV: "preview" })).toBe("disabled");
    for (const auth of [null, "Basic wrong", `Bearer ${"x".repeat(secret.length)}`, `bearer ${secret}`]) {
      expect(schedulerAuthorized(req({ auth }), { STATE_SYNC_SCHEDULER_SECRET: secret })).toBe("unauthorized");
    }
    expect(schedulerAuthorized(req(), { STATE_SYNC_SCHEDULER_SECRET: secret })).toBe("authorized");
  });
});

describe("owner-only action and replay-key scheduler boundary", () => {
  it.each(["Sign in before continuing.", "Only a household owner can do that."])("denies before any transport/configuration work: %s", async (error) => {
    vi.mocked(actionDenial).mockResolvedValue({ ok: false, error });
    expect(await syncSharedState()).toEqual({ ok: false, error });
    expect(actionDenial).toHaveBeenCalledWith("owner");
    expect(configuredStateSync).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each(["success", "busy", "conflict", "error"] as const)("returns safe owner feedback and refreshes persisted %s status", async (state) => {
    vi.mocked(configuredStateSync).mockResolvedValue({ state, replayed: false });
    expect(await syncSharedState()).toMatchObject({ ok: state === "success" });
    expect(configuredStateSync).toHaveBeenCalledWith(undefined, true);
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });
  it.each([new StateSyncConfigurationError(), new Error("PRIVATE_DATABASE_CONTENT")])("surfaces action failure without leaking internals", async (error) => {
    vi.mocked(configuredStateSync).mockRejectedValue(error);
    const response = await syncSharedState();
    expect(response).toMatchObject({ ok: false, error: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain("PRIVATE_DATABASE_CONTENT");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_DATABASE_CONTENT");
  });
  it.each(["disabled", "preview", "missing", "wrong"])("rejects %s scheduler access without starting a run", async (kind) => {
    if (kind === "disabled") vi.stubEnv("STATE_SYNC_SCHEDULER_SECRET", "");
    if (kind === "preview") vi.stubEnv("VERCEL_ENV", "preview");
    const response = await POST(req({ auth: kind === "missing" ? null : kind === "wrong" ? "Bearer wrong" : undefined }));
    expect(response.status).toBe(kind === "disabled" || kind === "preview" ? 503 : 401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(configuredStateSync).not.toHaveBeenCalled();
  });
  it.each([{ key: null }, { key: "invalid" }, { query: "?target=another-repository" }, { body: '{"classes":["people"]}' }])(
    "rejects request-controlled configuration or invalid replay keys: %j", async (options) => {
      expect((await POST(req(options))).status).toBe(400);
      expect(configuredStateSync).not.toHaveBeenCalled();
    },
  );
  it.each(["success", "busy", "conflict", "error"] as const)("returns uncached %s scheduler outcome and forwards only the replay key", async (state) => {
    vi.mocked(configuredStateSync).mockResolvedValue({ state, replayed: true });
    const response = await POST(req());
    expect(response.status).toBe(state === "success" ? 200 : state === "busy" || state === "conflict" ? 409 : 503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: state === "success", state, replayed: true });
    expect(configuredStateSync).toHaveBeenCalledWith(uuid);
  });
  it("accepts a genuinely empty HTTP body stream rather than rejecting an empty POST", async () => {
    vi.mocked(configuredStateSync).mockResolvedValue({ state: "success", replayed: false });
    expect((await POST(req({ body: "" }))).status).toBe(200);
  });
  it.each([1, 8])("handles %i zero-length chunks without accepting an unbounded body stream", async (count) => {
    vi.mocked(configuredStateSync).mockResolvedValue({ state: "success", replayed: false });
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { for (let i = 0; i < count; i++) controller.enqueue(new Uint8Array()); controller.close(); },
    });
    const request = req();
    vi.spyOn(request, "body", "get").mockReturnValue(stream);
    expect((await POST(request)).status).toBe(count === 1 ? 200 : 400);
  });
  it.each([new StateSyncConfigurationError(), new Error("PRIVATE_DATABASE_CONTENT")])("returns a sanitized scheduler failure", async (error) => {
    vi.mocked(configuredStateSync).mockRejectedValue(error);
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_DATABASE_CONTENT");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_DATABASE_CONTENT");
  });
});
