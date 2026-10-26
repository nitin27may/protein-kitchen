import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Migrations from this index on must be expand-only. Older migrations are exempt. */
const FIRST_POLICED_MIGRATION = 20;

const FORBIDDEN: [string, RegExp][] = [
  ["DROP TABLE", /\bDROP\s+TABLE\b/i],
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
  ["RENAME", /\bRENAME\b/i],
  ["ALTER ... TYPE", /\bALTER\s+COLUMN\b.*\bTYPE\b/i],
  ["SET NOT NULL", /\bSET\s+NOT\s+NULL\b/i],
  ["DROP CONSTRAINT", /\bDROP\s+CONSTRAINT\b/i],
];

function policyViolations(sql: string): string[] {
  const found: string[] = [];
  sql.split("\n").forEach((line, i) => {
    if (/--\s*contract-ok:\s*\S/.test(line)) return;
    for (const [name, pattern] of FORBIDDEN) if (pattern.test(line)) found.push(`line ${i + 1}: ${name}`);
  });
  return found;
}

describe("expand-only migration policy", () => {
  const folder = path.resolve("db/postgres-migrations");
  const files = fs.readdirSync(folder).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

  it("covers the migration that introduced the policy", () => {
    expect(files.some((f) => Number(f.slice(0, 4)) >= FIRST_POLICED_MIGRATION)).toBe(true);
  });

  it.each(files.filter((f) => Number(f.slice(0, 4)) >= FIRST_POLICED_MIGRATION))("%s is expand-only", (file) => {
    expect(policyViolations(fs.readFileSync(path.join(folder, file), "utf8")), file).toEqual([]);
  });

  it.each([
    'DROP TABLE "x";', 'ALTER TABLE "x" DROP COLUMN "y";', 'ALTER TABLE "x" RENAME TO "z";',
    'ALTER TABLE "x" RENAME COLUMN "a" TO "b";', 'ALTER TABLE "x" ALTER COLUMN "a" SET DATA TYPE integer;',
    'ALTER TABLE "x" ALTER COLUMN "a" TYPE integer;', 'ALTER TABLE "x" ALTER COLUMN "a" SET NOT NULL;',
    'ALTER TABLE "x" DROP CONSTRAINT "c";',
  ])("rejects %s", (sql) => {
    expect(policyViolations(sql)).toHaveLength(1);
  });

  it("allows a destructive line only with a stated reason", () => {
    expect(policyViolations('DROP TABLE "x"; -- contract-ok: table unused since 0021')).toEqual([]);
    expect(policyViolations('DROP TABLE "x"; -- contract-ok:')).toHaveLength(1);
  });

  it("accepts additive statements", () => {
    expect(policyViolations('CREATE TABLE "x" ("a" text);\nALTER TABLE "x" ADD COLUMN "b" text;\nCREATE INDEX i ON "x" ("a");')).toEqual([]);
  });
});
