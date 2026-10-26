import sharp from "sharp";
import { beforeEach, expect, it } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { approveLibraryCandidate, rejectLibraryCandidates, removeLibraryPhoto } from "../lib/human/library-photos";
import type { Candidate, CandidateFile } from "../lib/photos/candidates";
import { decidedLibraryReview } from "../lib/server/library-decided";
import { pendingLibraryReview } from "../lib/server/library-review";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let jpeg: Buffer;

const cand = (key: string): Candidate => ({
  key, provider: key.startsWith("commons:") ? "commons" : "openverse", title: `Photo ${key}`, author: "Someone", licence: "CC BY-SA 4.0",
  licence_url: null, source_url: "https://commons.wikimedia.org/wiki/File:X.jpg", image_url: "https://upload.wikimedia.org/x.jpg", width: 100, height: 80,
});
const file: CandidateFile = {
  recipes: { "falafel-bowl": [cand("commons:a"), cand("commons:b")], "tofu-bowl": [cand("commons:c")] },
  ingredients: { tofu: [cand("openverse:t1"), cand("openverse:t2")], rice: [cand("commons:r1")], "gone-ingredient": [cand("commons:g1")] },
};
const names = {
  recipes: new Map([["falafel-bowl", "Falafel bowl"], ["tofu-bowl", "Tofu bowl"]]),
  ingredients: new Map([["tofu", "Tofu"], ["rice", "Rice"]]),
};

async function addRecipe(slug: string) {
  await h.db.insert(s.recipes).values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 }).onConflictDoNothing();
}
async function addIngredient(slug: string) {
  await h.db.insert(s.ingredients).values({
    slug, name: slug, aliases: [], state: "ready", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, fibreG: 0, source: "CNF", sourceId: "1", aisle: "produce",
    whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  }).onConflictDoNothing();
}
const store = createMemoryStore();
const approve = (kind: "recipe" | "ingredient", slug: string, candidate: Candidate) => approveLibraryCandidate(h.db, store, {
  candidateKey: candidate.key, subjectKind: kind, subjectSlug: slug, origin: candidate.provider, bytes: jpeg,
  credit: { title: candidate.title, author: candidate.author, licence: candidate.licence, licenceUrl: null, sourceUrl: candidate.source_url }, licenceCheckedAt: null, personId: null,
});

beforeEach(async () => {
  h = await openDb();
  jpeg = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#c87828" } }).jpeg().toBuffer();
  for (const slug of ["falafel-bowl", "tofu-bowl"]) await addRecipe(slug);
  for (const slug of ["tofu", "rice"]) await addIngredient(slug);
});

it("is empty before anything is decided", async () => {
  expect(await decidedLibraryReview(h.db, file, names)).toEqual([]);
});

it("lists approved photos (cover first) and rejected candidates that are still in the file, by name", async () => {
  expect((await approve("recipe", "falafel-bowl", file.recipes["falafel-bowl"]![0]!)).status).toBe("approved");
  expect((await approve("recipe", "falafel-bowl", file.recipes["falafel-bowl"]![1]!)).status).toBe("approved");
  expect((await approve("ingredient", "tofu", file.ingredients.tofu![0]!)).status).toBe("approved");
  await rejectLibraryCandidates(h.db, [
    { subjectKind: "ingredient", subjectSlug: "tofu", candidateKey: "openverse:t2" },
    { subjectKind: "ingredient", subjectSlug: "rice", candidateKey: "commons:r1" },
    { subjectKind: "ingredient", subjectSlug: "rice", candidateKey: "commons:not-in-file" },
    { subjectKind: "ingredient", subjectSlug: "gone-ingredient", candidateKey: "commons:g1" },
    { subjectKind: "recipe", subjectSlug: "tofu-bowl", candidateKey: "commons:no-longer-listed" },
  ], null);

  const all = await decidedLibraryReview(h.db, file, names);
  expect(all.map((x) => [x.kind, x.slug, x.name, x.photos.length, x.rejected.map((c) => c.key)])).toEqual([
    ["recipe", "falafel-bowl", "Falafel bowl", 2, []],
    ["ingredient", "rice", "Rice", 0, ["commons:r1"]],
    ["ingredient", "tofu", "Tofu", 1, ["openverse:t2"]],
  ]);
  expect(all[0]!.photos[0]).toMatchObject({ title: "Photo commons:a", isCover: true, origin: "commons", licence: "CC BY-SA 4.0" });
  expect(all[0]!.photos[1]!.isCover).toBe(false);
});

it("filters by kind, search text and 'without a photo'", async () => {
  await approve("recipe", "falafel-bowl", file.recipes["falafel-bowl"]![0]!);
  await approve("ingredient", "tofu", file.ingredients.tofu![0]!);
  await rejectLibraryCandidates(h.db, [{ subjectKind: "ingredient", subjectSlug: "rice", candidateKey: "commons:r1" }, { subjectKind: "recipe", subjectSlug: "tofu-bowl", candidateKey: "commons:c" }], null);
  const slugs = async (filter: Parameters<typeof decidedLibraryReview>[3]) => (await decidedLibraryReview(h.db, file, names, filter)).map((x) => x.slug);
  expect(await slugs({ kind: "recipe" })).toEqual(["falafel-bowl", "tofu-bowl"]);
  expect(await slugs({ kind: "ingredient" })).toEqual(["rice", "tofu"]);
  expect(await slugs({ kind: "all", q: "  TOFU " })).toEqual(["tofu", "tofu-bowl"]);
  expect(await slugs({ q: "rice" })).toEqual(["rice"]);
  expect(await slugs({ onlyWithoutPhoto: true })).toEqual(["rice", "tofu-bowl"]);
});

it("moves a removed photo to rejected, and undoing a rejection returns it to the pending list", async () => {
  const [first] = [file.recipes["falafel-bowl"]![0]!];
  const approved = await approve("recipe", "falafel-bowl", first);
  if (approved.status !== "approved") throw new Error("setup");
  expect(await removeLibraryPhoto(h.db, store, approved.uid, null)).toBe(true);
  const after = await decidedLibraryReview(h.db, file, names);
  expect(after).toHaveLength(1);
  expect(after[0]!.photos).toEqual([]);
  expect(after[0]!.rejected.map((c) => c.key)).toEqual(["commons:a"]);
  expect((await pendingLibraryReview(h.db, file, names)).flatMap((i) => i.candidates.map((c) => c.key))).not.toContain("commons:a");
});

it("reports each pending subject's photo count for the cap warning", async () => {
  await approve("ingredient", "tofu", file.ingredients.tofu![0]!);
  const pending = await pendingLibraryReview(h.db, file, names, { kind: "ingredient" });
  expect(pending.map((i) => [i.slug, i.photoCount, i.hasPhoto])).toEqual([["rice", 0, false], ["tofu", 1, true]]);
});
