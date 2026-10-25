import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const close = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { query, release, close, connect, migrate: vi.fn(), preflight: vi.fn(), open: vi.fn() };
});
vi.mock("../lib/db/postgres/verified-client", () => ({ openVerifiedPostgres: fixture.open }));
vi.mock("../lib/deployment/preflight", () => ({ previewPreflight: fixture.preflight }));
vi.mock("drizzle-orm/migrator", () => ({
  readMigrationFiles: () => [{ hash: "reviewed", folderMillis: 1 }],
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: (client: unknown) => client }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: fixture.migrate }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("DATABASE_ENV", "preview");
  vi.stubEnv("DATABASE_URL", "postgres://fixture@ep-fixture-pooler.neon.tech/fixture");
  vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://fixture@ep-fixture.neon.tech/fixture");
  vi.stubEnv("DATABASE_NONPRODUCTION_HOST", "ep-fixture-pooler.neon.tech");
  vi.stubEnv("DATABASE_DIRECT_NONPRODUCTION_HOST", "ep-fixture.neon.tech");
  vi.stubEnv("NEON_DEVELOPMENT_BRANCH_ID", "br-fixture");
  vi.stubEnv("NEON_PRODUCTION_BRANCH_ID", "br-production");
  vi.stubEnv("PREVIEW_MIGRATION_BRANCH", "br-fixture");
  fixture.preflight.mockResolvedValue({ configurationValid: true, liveBranchVerified: true, failed: [] });
  fixture.open.mockResolvedValue({ pool: { connect: fixture.connect }, close: fixture.close });
});
afterEach(() => { vi.unstubAllEnvs(); });

function queries({ occupied = false, divergent = false, complete = true } = {}) {
  let reads = 0;
  fixture.query.mockImplementation(async (query: string) => {
    if (query.includes("pg_advisory_lock")) return { rows: [] };
    if (query.includes("to_regclass")) return { rows: [{ name: "drizzle.__drizzle_migrations" }] };
    if (query.includes("select hash")) {
      reads++;
      return { rows: divergent ? [{ hash: "unreviewed", created_at: "1" }]
        : reads === 1 || !complete ? [] : [{ hash: "reviewed", created_at: "1" }] };
    }
    if (query.includes("pg_tables")) return { rows: [{ tablename: "recipes" }, { tablename: "people" }] };
    if (query.includes("exists(select")) return { rows: [{ occupied }] };
    throw new Error("Unexpected fixture query.");
  });
}

describe("actual operator preview migration runner", () => {
  it("verifies live preflight, holds a session lock, rejects human state, migrates and checks final parity", async () => {
    queries();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("../scripts/migrate-preview");
      expect(fixture.query.mock.calls[0]![0]).toContain("pg_advisory_lock");
      expect(fixture.query.mock.calls.some(([query]) => String(query).includes('public."recipes"'))).toBe(false);
      expect(fixture.query.mock.calls.some(([query]) => String(query).includes('public."people"'))).toBe(true);
      expect(fixture.migrate).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledWith(true);
      expect(fixture.close).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it.each([
    { occupied: true }, { divergent: true },
  ])("refuses unsafe schema/state %j before migrations and destroys the lock session", async (options) => {
    queries(options);
    await expect(import("../scripts/migrate-preview")).rejects.toThrow();
    expect(fixture.migrate).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("refuses failed live preflight before opening any database", async () => {
    fixture.preflight.mockResolvedValue({ configurationValid: true, liveBranchVerified: false, failed: ["live-branch"] });
    await expect(import("../scripts/migrate-preview")).rejects.toThrow("preflight refused");
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("does not report success when final ledger parity fails", async () => {
    queries({ complete: false });
    await expect(import("../scripts/migrate-preview")).rejects.toThrow("pending or divergent");
    expect(fixture.migrate).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("propagates migration failure and always closes the advisory-lock session", async () => {
    queries();
    fixture.migrate.mockRejectedValueOnce(new Error("DDL refused"));
    await expect(import("../scripts/migrate-preview")).rejects.toThrow("DDL refused");
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
