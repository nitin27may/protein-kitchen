import path from "node:path";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadData, type DataSet } from "../lib/data/load";
import { libraryStatus } from "../lib/db/library-version";
import { seedDatabase } from "../lib/db/seed";
import { healthReport } from "../lib/health/status";
import { openDb } from "./helpers/db";

vi.mock("../lib/server/context", () => ({
  getData: () => { throw new Error("fake"); },
  getHealthDb: async () => { throw new Error("fake"); },
}));

const sha = "a".repeat(40);
let data: DataSet;
beforeAll(() => { data = loadData(path.resolve(__dirname, "..")); });
const variant = (n: number): DataSet => {
  const recipes = new Map(data.recipes);
  const [slug, recipe] = [...recipes][0]!;
  recipes.set(slug, { ...recipe, name: `${recipe.name} h${n}` });
  return { ...data, recipes };
};

describe("libraryStatus", () => {
  it("reports exact, compatible, stale and unseeded", async () => {
    const h = await openDb();
    try {
      expect(await libraryStatus(h.db, data)).toBe("stale");
      await seedDatabase(h.db, data, { initializeFeedback: false });
      expect(await libraryStatus(h.db, data)).toBe("exact");
      await seedDatabase(h.db, variant(1), { initializeFeedback: false });
      expect(await libraryStatus(h.db, data)).toBe("compatible");
      expect(await libraryStatus(h.db, variant(1))).toBe("exact");
      expect(await libraryStatus(h.db, variant(99))).toBe("stale");
    } finally { await h.close(); }
  });
});

describe("healthReport", () => {
  it("is ok and exact against a seeded database", async () => {
    const h = await openDb();
    try {
      await seedDatabase(h.db, data, { initializeFeedback: false });
      const r = await healthReport({ release: sha, db: async () => h.db, data: () => data });
      expect(r).toEqual({ status: 200, body: { ok: true, release: sha, database: "ok", library: "exact" } });
      await seedDatabase(h.db, variant(2), { initializeFeedback: false });
      const c = await healthReport({ release: sha, db: async () => h.db, data: () => data });
      expect(c).toEqual({ status: 200, body: { ok: true, release: sha, database: "ok", library: "compatible" } });
      const s = await healthReport({ release: sha, db: async () => h.db, data: () => variant(77) });
      expect(s).toEqual({ status: 503, body: { ok: false, release: sha, database: "ok", library: "stale" } });
    } finally { await h.close(); }
  });

  const secret = "marker-hunter2 at ep-secret-host.neon.tech";
  const failures: [string, () => Promise<never> | never, boolean][] = [
    ["connection error carrying a URL", () => { throw new Error(`connect failed ${secret}`); }, true],
    ["rejected pool open", () => Promise.reject(new Error(secret)), true],
    ["non-Error rejection", () => Promise.reject(secret), true],
    ["data load failure", () => { throw new Error(secret); }, false],
  ];
  for (const [label, fail, dbFails] of failures) {
    it(`redacts everything for: ${label}`, async () => {
      const r = await healthReport({
        release: sha,
        db: dbFails ? (async () => fail()) : (async () => ({}) as never),
        data: dbFails ? () => data : (fail as never),
      });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, release: sha, database: "unavailable", library: "stale" });
      expect(JSON.stringify(r)).not.toMatch(/hunter2|neon|postgres|connect/);
    });
  }

  it("never echoes an unexpected release value", async () => {
    for (const release of [undefined, "", "not-a-sha", secret]) {
      const r = await healthReport({ release, db: () => Promise.reject(new Error("x")), data: () => data });
      expect(r.body.release).toBe("unknown");
    }
  });
});

describe("/api/health route", () => {
  it("is GET-only, uncached, unauthenticated and does not use the version gate", async () => {
    const text = readFileSync("app/api/health/route.ts", "utf8");
    expect(text).toContain('"Cache-Control": "no-store"');
    expect(text).toContain("process.env.APP_RELEASE_SHA");
    expect(text).not.toMatch(/routeAccess|requireMember|getDb\b|headers\(|cookies\(/);
    expect(readFileSync("next.config.ts", "utf8")).toMatch(/env: \{ APP_RELEASE_SHA/);
    expect(readFileSync("next.config.ts", "utf8")).not.toContain("NEXT_PUBLIC_APP_RELEASE");
  });
  it("returns the redacted report as JSON with no-store", async () => {
    const { GET } = await import("../app/api/health/route");
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: false, release: "unknown", database: "unavailable", library: "stale" });
    expect(res.status).toBe(503);
  });
});
