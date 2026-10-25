import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) },
  Pool: vi.fn(),
  attach: vi.fn(),
}));
vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: mocks.attach }));

import { openPostgres } from "../lib/db/postgres/client";

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Postgres pool lifecycle", () => {
  it("validates before allocating a pool", () => {
    expect(() => openPostgres({
      connectionString: "postgres://example.com/app",
      runtimeEnvironment: "development", databaseEnvironment: "production",
    })).toThrow("must match");
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it("limits connections, enables Vercel lifecycle management and closes explicitly", async () => {
    mocks.Pool.mockImplementation(function () { return mocks.pool; });
    vi.stubEnv("VERCEL", "1");
    const handle = openPostgres({
      connectionString: "postgres://localhost/fixture", runtimeEnvironment: "test", databaseEnvironment: "test",
    });
    expect(mocks.Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 }));
    expect(mocks.attach).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    await handle.close();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it("does not attach local pools to Vercel", async () => {
    mocks.Pool.mockImplementation(function () { return mocks.pool; });
    vi.stubEnv("VERCEL", "");
    const handle = openPostgres({
      connectionString: "postgres://localhost/fixture", runtimeEnvironment: "development", databaseEnvironment: "development",
    });
    expect(mocks.attach).not.toHaveBeenCalled();
    await handle.close();
  });

  it("reports idle connection failures without logging connection details", async () => {
    mocks.Pool.mockImplementation(function () { return mocks.pool; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = openPostgres({
      connectionString: "postgres://localhost/fixture", runtimeEnvironment: "test", databaseEnvironment: "test",
    });
    const listener = mocks.pool.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(typeof listener).toBe("function");
    listener(Object.assign(new Error("secret connection detail"), { code: "ECONNRESET" }));
    expect(log).toHaveBeenCalledWith("Postgres idle connection failed.", { name: "Error", code: "ECONNRESET" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    await handle.close();
  });
});
