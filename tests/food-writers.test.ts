import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const WRITERS = [path.join("lib", "human", "household-foods.ts"), path.join("lib", "human", "food-log.ts")];

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sources(rel);
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) ? [rel] : [];
  });
}

const app = ["lib", "app", "components", "scripts"].filter((d) => fs.existsSync(path.join(root, d))).flatMap(sources);
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const drizzle = /\.(insert|update|delete)\(\s*(?:\w+\.)?(?:householdFoods|foodLog)\b/;
const rawSql = /\b(insert\s+into|update|delete\s+from)\s+"?(?:household_foods|food_log)\b/i;

describe("household foods and the food log have two writers", () => {
  it("scans real files", () => {
    for (const writer of WRITERS) expect(app).toContain(writer);
    expect(app.length).toBeGreaterThan(50);
  });

  it("no file but the two writer modules inserts, updates or deletes household_foods or food_log", () => {
    const offenders = app.filter((file) => !WRITERS.includes(file) && [drizzle, rawSql].some((pattern) => pattern.test(read(file))));
    expect(offenders).toEqual([]);
  });

  it("the detector would catch a writer (self-check)", () => {
    expect(drizzle.test("await tx.insert(s.householdFoods).values({})")).toBe(true);
    expect(drizzle.test("await db.delete(foodLog)")).toBe(true);
    expect(drizzle.test("await db.update(s.foodLog).set({})")).toBe(true);
    expect(drizzle.test("await db.select().from(s.foodLog)")).toBe(false);
    expect(rawSql.test('delete from "food_log" where true')).toBe(true);
  });

  it("raw sql tags elsewhere do not mutate either table", () => {
    const offenders = app.filter((file) => !WRITERS.includes(file) && /sql`[^`]*\b(insert into|update|delete from)\s+(household_foods|food_log)/i.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("the only writer of label_extractions is its own operational module", () => {
    const offenders = app.filter((file) => file !== path.join("lib", "server", "label-extractions.ts") && /\.(insert|update|delete)\(\s*(?:\w+\.)?labelExtractions\b/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

describe("the agent cannot write the human-owned food data", () => {
  const scripts = app.filter((f) => f.startsWith("scripts"));
  const names = ["household-foods", "food-log", "createHouseholdFood", "updateHouseholdFood", "archiveHouseholdFood", "restoreHouseholdFood", "deleteHouseholdFood",
    "attachFoodLabelPhoto", "logFoodEntry", "updateFoodEntry", "deleteFoodEntry", "markPlannedMealEaten", "householdFoodsClass", "foodLogClass", "clearHouseholdFoods", "clearFoodLog"];

  it("scans the scripts folder", () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  it("no script imports either writer module or any of its functions", () => {
    const offenders = scripts.filter((file) => names.some((name) => new RegExp(`(?:["'/]|\\b)${name}(?:["']|\\b)`).test(read(file))));
    expect(offenders).toEqual([]);
  });

  it("no script writes the tables or the labels/ blob prefix", () => {
    const offenders = scripts.filter((file) => /household_foods|food_log|householdFoods|foodLog|["'`]labels\//.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
