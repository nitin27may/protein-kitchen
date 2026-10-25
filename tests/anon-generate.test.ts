import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { buildGroceryList } from "../lib/grocery/aggregate";
import { AnonProfileSchema, AnonDraftSchema, anonProfileToTarget, draftToPlannedSlots, planMatchesDraft } from "../lib/plan/anon-draft";
import { anonFeasibility, anonGroceries, generateAnonPlan, planInputFor } from "../lib/plan/anon-generate";
import { AnonLibraryPayloadSchema, buildAnonLibraryPayload, hydrateAnonLibrary } from "../lib/plan/anon-library";
import { buildCandidates } from "../lib/planner/candidates";
import { CreatePlanInput } from "../lib/plan/create-plan-input";
import { generatePlan } from "../lib/planner/generate";
import { computeFeasibility } from "../lib/planner/feasibility";
import { anonLibrary, currentLibraryVersion } from "../lib/server/anon-library";
import { GET } from "../app/api/anon-library/route";

const data = loadData(process.cwd());
const now = new Date("2026-11-02T10:00:00Z");
const profile = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 110 }, avoided: [] });
const setup = {
  personIds: [1], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["breakfast", "lunch", "dinner"] as ("breakfast" | "lunch" | "dinner")[],
  cuisineBalance: 0.5, maxActiveMin: null, pinned: [], prefs: { "1": { liked: [], avoided: [] } },
};
/** What the browser sees: the JSON the route serves, parsed and validated. */
const wire = () => hydrateAnonLibrary(JSON.parse(anonLibrary(data).body));

describe("library payload", () => {
  it("has no household data and survives a JSON round trip", () => {
    const { payload, body } = anonLibrary(data);
    expect(AnonLibraryPayloadSchema.parse(JSON.parse(body))).toBeTruthy();
    expect(payload.candidates.length).toBeGreaterThan(50);
    expect(payload.candidates.every((c) => !c.favourite && !c.banned && c.rating === null && !c.tested)).toBe(true);
    expect(body).not.toMatch(/householdId|userId|email|notes|photo|steps|evidence/i);
    expect(Object.keys(payload.recipes).length).toBeGreaterThanOrEqual(payload.candidates.length);
    expect(Object.values(payload.recipes).some((r) => r.items.some((i) => "component" in i))).toBe(true);
    expect(body.length).toBeLessThan(2_000_000);
  });

  it("is built once per data set and carries the library version", () => {
    expect(anonLibrary(data)).toBe(anonLibrary(data));
    expect(currentLibraryVersion(data)).toMatch(/^[0-9a-f]{64}$/);
    expect(buildAnonLibraryPayload(data, "v").libraryVersion).toBe("v");
  });

  it("is served publicly with cache headers and no cookies", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("ETag")).toBe(`"${currentLibraryVersion(data)}"`);
    expect(await response.text()).toBe(anonLibrary(data).body);
  });

  it("rejects a malformed or wrong-version payload", () => {
    const good = JSON.parse(anonLibrary(data).body);
    expect(() => hydrateAnonLibrary({ ...good, v: 2 })).toThrow();
    expect(() => hydrateAnonLibrary({ ...good, candidates: [{ slug: "x" }] })).toThrow();
    expect(() => hydrateAnonLibrary(null)).toThrow();
  });
});

describe("on-device generation", () => {
  it("gives the same plan in the browser path and the server path for the same seed", () => {
    const library = wire();
    const server = generatePlan(planInputFor(CreatePlanInput.parse(setup), profile, 4242), buildCandidates(data, new Map()));
    const result = generateAnonPlan({ setup, profile, library, seed: 4242, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.slots).toEqual(server.slots);
    expect(result.plan.days).toEqual(server.days);
    expect(planMatchesDraft(result.draft, server.slots, "1")).toBe(true);
    expect(AnonDraftSchema.parse(result.draft)).toEqual(result.draft);
    expect(draftToPlannedSlots(result.draft).map((s) => [s.date, s.slot, s.recipeSlug])).toEqual(server.slots.map((s) => [s.date, s.slot, s.recipeSlug]));
  });

  it("is repeatable and different seeds differ", () => {
    const library = wire();
    const a = generateAnonPlan({ setup, profile, library, seed: 1, now });
    const b = generateAnonPlan({ setup, profile, library, seed: 1, now });
    const c = generateAnonPlan({ setup, profile, library, seed: 2, now });
    expect(a).toEqual(b);
    expect(a.ok && c.ok && JSON.stringify(a.draft.slots) !== JSON.stringify(c.draft.slots)).toBe(true);
  });

  it("honours avoided ingredients from the profile", () => {
    const library = wire();
    const plain = generateAnonPlan({ setup, profile, library, seed: 9, now });
    if (!plain.ok) throw new Error("expected a plan");
    const used = library.candidates.find((c) => c.slug === plain.draft.slots[0]!.recipeSlug)!;
    const avoid = [...used.ingredients][0]!;
    const picky = AnonProfileSchema.parse({ protein: { mode: "fixed", grams: 110 }, avoided: [avoid] });
    expect([...anonProfileToTarget(picky).avoided]).toEqual([avoid]);
    const result = generateAnonPlan({ setup, profile: picky, library, seed: 9, now });
    if (!result.ok) throw new Error("expected a plan");
    for (const slot of result.draft.slots) {
      expect(library.candidates.find((c) => c.slug === slot.recipeSlug)!.ingredients.has(avoid)).toBe(false);
    }
  });

  it("reports bad setups and impossible choices without throwing", () => {
    const library = wire();
    expect(generateAnonPlan({ setup: { ...setup, mealTypes: [] }, profile, library, seed: 1, now })).toMatchObject({ ok: false });
    expect(generateAnonPlan({ setup: { ...setup, endDate: "2026-10-01" }, profile, library, seed: 1, now })).toMatchObject({ ok: false });
    expect(generateAnonPlan({ setup: { ...setup, endDate: "2027-03-01" }, profile, library, seed: 1, now })).toMatchObject({ ok: false });
    const empty = { ...library, candidates: [] };
    expect(generateAnonPlan({ setup, profile, library: empty, seed: 1, now })).toMatchObject({ ok: false, error: expect.stringContaining("No recipes") });
    expect(anonFeasibility({ ...setup, mealTypes: [] }, profile, library)).toMatchObject({ ok: false });
  });

  it("runs the feasibility check from the payload with the same answer as the server function", () => {
    const library = wire();
    const check = anonFeasibility(setup, profile, library);
    if (!check.ok) throw new Error("expected a result");
    const parsed = { ...setup, healthFocus: { nutrientDense: true, lowSugar: true, light: true }, prepStyle: "leftovers" as const };
    expect(check.result).toEqual(computeFeasibility(parsed, buildCandidates(data, new Map()), [anonProfileToTarget(profile)]));
  });

  it("builds the same grocery list from the trimmed payload as from the full library", () => {
    const library = wire();
    const result = generateAnonPlan({ setup, profile, library, seed: 77, now });
    if (!result.ok) throw new Error("expected a plan");
    const meals = result.plan.slots.map((s) => ({ recipeSlug: s.recipeSlug, servings: s.servings["1"]! }));
    const full = buildGroceryList(meals, data.recipes, data.ingredients);
    const trimmed = anonGroceries(result.draft, library);
    expect(trimmed).toEqual(full);
    expect(trimmed.lines.length).toBeGreaterThan(5);
  });
});

/** Walks the real import graph so a Node-only or database import cannot slip into the browser bundle unnoticed. */
describe("browser bundle safety", () => {
  const entries = ["lib/plan/anon-draft.ts", "lib/plan/anon-library.ts", "lib/plan/anon-generate.ts", "lib/plan/create-plan-input.ts"];
  const bannedPackages = /^(node:|fs$|path$|crypto$|os$|child_process$|net$|tls$|drizzle-orm|@electric-sql|pg$|postgres$|better-sqlite3|better-auth|next\/(headers|server|cache)|server-only|sharp|gray-matter|@neondatabase)/;
  const bannedPaths = /^(lib\/(db|server|human|auth\/(?!browser\.ts$)|blob|photos|backup|sync|reminders|deployment)|app\/|db\/)/;

  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.posix.join(path.posix.dirname(from), spec) : null;
    if (base === null) return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
    throw new Error(`Cannot resolve ${spec} from ${from}`);
  }

  function graph() {
    const seen = new Map<string, string[]>();
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const specs: string[] = [];
      for (const node of source.statements) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) specs.push(node.moduleSpecifier.text);
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) specs.push(node.moduleSpecifier.text);
      }
      seen.set(file, specs);
      for (const spec of specs) {
        const next = resolve(file, spec);
        if (next) queue.push(next);
      }
    }
    return seen;
  }

  it("reaches no Node built-in, database, server or framework-server module at runtime", () => {
    const seen = graph();
    expect(seen.size).toBeGreaterThan(10);
    for (const [file, specs] of seen) {
      expect(bannedPaths.test(file), `${file} must not be in the browser graph`).toBe(false);
      for (const spec of specs) {
        const resolved = resolve(file, spec);
        expect(bannedPackages.test(spec), `${file} imports ${spec}`).toBe(false);
        if (resolved) expect(bannedPaths.test(resolved), `${file} imports ${spec}`).toBe(false);
      }
    }
    expect([...seen.keys()]).toEqual(expect.arrayContaining(["lib/planner/generate.ts", "lib/grocery/aggregate.ts", "lib/auth/browser.ts"]));
  });

  it("has no top-level use of process, fs or globals that only exist on a server", () => {
    for (const file of graph().keys()) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\bprocess\.|\brequire\(|__dirname|import\.meta\.dirname/);
    }
  });
});
