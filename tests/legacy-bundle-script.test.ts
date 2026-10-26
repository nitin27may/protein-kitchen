import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseLegacyBundle } from "../lib/legacy/bundle";
import { createLegacySource } from "./helpers/legacy-source";

let source: ReturnType<typeof createLegacySource>;
let out: string;
beforeEach(() => {
  source = createLegacySource();
  out = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bundle-"));
});
afterEach(() => { source.close(); fs.rmSync(out, { recursive: true }); });

const tsx = path.resolve("node_modules/.bin/tsx");
const run = (...args: string[]) => spawnSync(tsx, ["scripts/legacy-bundle.ts", ...args], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: undefined, HOME: out },
});

it("writes a verified bundle from a read-only copy, applies renames and never overwrites", () => {
  const file = path.join(out, "bundle.json");
  source.sqlite.prepare("insert into recipes (id, slug, name, kind, family, meal_slots, cuisine, is_indian, servings, prep_min, active_min, total_min, equipment, tags, fridge_days) values (203, 'baked-falafel-mix', 'Old', 'recipe', 'test', '[]', 'test', 0, 1, 1, 1, 2, '[]', '[]', 1)").run();
  source.sqlite.prepare("insert into recipe_feedback (recipe_id, status, favourite, banned) values (203, 'draft', 1, 0)").run();
  source.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const before = fs.readFileSync(source.file);
  const result = run("--with-plans", source.file, file);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("people: 2");
  expect(result.stdout).toContain("Excluded: library tables");
  const bundle = parseLegacyBundle(fs.readFileSync(file, "utf8"));
  expect(bundle.with_plans).toBe(true);
  expect(bundle.data.recipe_feedback.map((r) => r.recipe)).toContain("baked-falafel");
  expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
  expect(fs.readFileSync(source.file).equals(before)).toBe(true);
  expect(run(source.file, file).status).not.toBe(0);
});

it("builds without plans by default and rejects relative paths, bad flags and identical paths", () => {
  const file = path.join(out, "plain.json");
  expect(run(source.file, file).status).toBe(0);
  expect(parseLegacyBundle(fs.readFileSync(file, "utf8")).data.plans).toEqual([]);
  for (const args of [["relative.db", path.join(out, "x.json")], [source.file, "relative.json"], ["--nope", source.file, path.join(out, "y.json")], [source.file], [source.file, source.file]]) {
    const failed = run(...args);
    expect(failed.status, args.join(" ")).not.toBe(0);
  }
});
void execFileSync;
