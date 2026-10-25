import { describe, expect, it } from "vitest";
import { runtimeTarget } from "../lib/db/postgres/runtime-target";
import { libraryVersion } from "../lib/db/library-version";
import { loadData } from "../lib/data/load";

describe("application Postgres configuration", () => {
  const env = { NODE_ENV: "development", DATABASE_ENV: "development", DATABASE_URL: "postgres://localhost/fixture" };
  it("requires explicit configuration rather than falling back to SQLite", () => {
    expect(() => runtimeTarget({})).toThrow("runtime environment");
    expect(() => runtimeTarget({ ...env, DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(() => runtimeTarget({ ...env, DATABASE_ENV: "" })).toThrow("DATABASE_ENV");
    expect(() => runtimeTarget({ ...env, DATABASE_ENV: "unknown" })).toThrow("DATABASE_ENV");
  });
  it("rejects runtime/database mismatches including Vercel previews", () => {
    expect(() => runtimeTarget({ ...env, DATABASE_ENV: "production" })).toThrow("must match");
    expect(() => runtimeTarget({ ...env, VERCEL_ENV: "preview" })).toThrow("must match");
  });
  it("uses the same endpoint guard for application traffic", () => {
    expect(() => runtimeTarget({ ...env, DATABASE_URL: "postgres://example.com/fixture" })).toThrow("reviewed");
    expect(runtimeTarget(env)).toMatchObject({ runtimeEnvironment: "development", databaseEnvironment: "development" });
  });
});

describe("library content version", () => {
  const data = loadData(process.cwd());
  it("is stable across map ordering", () => {
    expect(libraryVersion({ ...data, recipes: new Map([...data.recipes].reverse()) })).toBe(libraryVersion(data));
  });
  it("detects changed content without relying on counts", () => {
    const recipes = new Map(data.recipes);
    const [slug, recipe] = [...recipes][0]!;
    recipes.set(slug, { ...recipe, name: `${recipe.name} changed` });
    expect(recipes.size).toBe(data.recipes.size);
    expect(libraryVersion({ ...data, recipes })).not.toBe(libraryVersion(data));
  });
});
