import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const WRITER = path.join("lib", "human", "library-photos.ts");

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sources(rel);
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) ? [rel] : [];
  });
}

const app = ["lib", "app", "components", "scripts"].filter((d) => fs.existsSync(path.join(root, d))).flatMap(sources);
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("library photo tables have one writer", () => {
  it("scans real files", () => {
    expect(app).toContain(WRITER);
    expect(app.length).toBeGreaterThan(50);
  });

  it("no file but lib/human/library-photos.ts inserts, updates or deletes library_photos / library_photo_decisions", () => {
    const drizzle = /\.(insert|update|delete)\(\s*(?:\w+\.)?library(?:Photos|PhotoDecisions)\b/;
    const named = /(?:insert|update|delete)\s*\(\s*(?:libraryPhotos|libraryPhotoDecisions)\b/;
    const rawSql = /\b(insert\s+into|update|delete\s+from)\s+"?library_photo(?:s|_decisions)\b/i;
    const offenders = app.filter((file) => file !== WRITER && [drizzle, named, rawSql].some((pattern) => pattern.test(read(file))));
    expect(offenders).toEqual([]);
  });

  it("the detector would catch a writer (self-check)", () => {
    const drizzle = /\.(insert|update|delete)\(\s*(?:\w+\.)?library(?:Photos|PhotoDecisions)\b/;
    expect(drizzle.test("await tx.insert(s.libraryPhotos).values({})")).toBe(true);
    expect(drizzle.test("await db.delete(libraryPhotoDecisions)")).toBe(true);
    expect(drizzle.test("await db.select().from(s.libraryPhotos)")).toBe(false);
  });

  it("no other file under lib/human, app or lib/server mutates through a raw sql tag either", () => {
    const offenders = app.filter((file) => file !== WRITER && /sql`[^`]*\b(insert into|update|delete from)\s+library_photo/i.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

describe("the agent cannot approve", () => {
  const writers = ["approveLibraryCandidate", "rejectLibraryCandidates", "removeLibraryPhoto", "setLibraryCover", "undoLibraryRejection", "libraryPhotosClass", "libraryPhotoDecisionsClass"];
  const scripts = app.filter((f) => f.startsWith("scripts"));

  it("scans the scripts folder", () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  it("no script imports the library writer module or any of its functions", () => {
    const offenders = scripts.filter((file) => {
      const text = read(file);
      return /library-photos["']/.test(text) || /from\s+["'][^"']*lib\/human["']/.test(text) && writers.some((w) => text.includes(w)) || writers.some((w) => new RegExp(`\\b${w}\\b`).test(text));
    });
    expect(offenders).toEqual([]);
  });

  it("no script imports the approval pipeline, the review actions or the download seam", () => {
    const modules = [/library-review["']/, /photos\/review\/actions["']/, /remote-seam["']/, /lib\/library-photos\/tags["']/, /\b(approveBatch|approveLibraryBatch|rejectLibraryBatch|curatorDenial)\b/];
    const offenders = scripts.filter((file) => modules.some((pattern) => pattern.test(read(file))));
    expect(offenders).toEqual([]);
  });

  it("only the disposable e2e server may name PHOTO_REMOTE_TEST_DIR, as a plain env assignment next to its loopback guard note", () => {
    const E2E_SERVER = path.join("scripts", "e2e-server.ts");
    expect(scripts.filter((file) => /PHOTO_REMOTE_TEST_DIR/.test(read(file)))).toEqual([E2E_SERVER]);
    const text = read(E2E_SERVER);
    expect(text.match(/PHOTO_REMOTE_TEST_DIR/g)).toHaveLength(1);
    expect(text).toMatch(/^env\.PHOTO_REMOTE_TEST_DIR = path\.resolve\("tests\/fixtures\/photos"\);$/m);
    expect(text).toMatch(/loopback protein_kitchen_e2e \(checked by e2eTarget above\)[\s\S]*not Vercel/);
    expect(text).toMatch(/const target = e2eTarget\(process\.env\.POSTGRES_E2E_URL\);/);
  });

  it("only the review actions call the batch approval", () => {
    const callers = app.filter((file) => /\bapproveBatch\(/.test(read(file)) && file !== path.join("lib", "server", "library-review.ts"));
    expect(callers).toEqual([path.join("app", "photos", "review", "actions.ts")]);
  });

  it("no script writes the library tables or the 'library/' blob prefix", () => {
    const offenders = scripts.filter((file) => /library_photo|libraryPhoto|["'`]library\//.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
