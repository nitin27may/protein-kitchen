import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { applyRenames } from "../lib/db/renames";
import { deleteHousehold } from "../lib/human/reset";
import { exportHumanData, importHumanData } from "../lib/human";
import {
  approveLibraryCandidate, LIBRARY_PHOTO_CAP, libraryPhotoDecisionsClass, libraryPhotosClass, rejectLibraryCandidates, removeLibraryPhoto,
  setLibraryCover, undoLibraryRejection, type LibraryApproveInput,
} from "../lib/human/library-photos";
import { resolveHouseholdAccess } from "../lib/auth/household-access";
import { checkPhotos } from "../lib/photos/check";
import { libraryPhotoKeys, photoKeys } from "../lib/photos/keys";
import { PhotoError } from "../lib/photos/process";
import { resetData } from "../lib/server/reset";
import { resetHouseholdData } from "../lib/server/household-reset";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let store: ReturnType<typeof createMemoryStore>;

const image = (w = 3000, h2 = 2000, colour = "#c87828") => sharp({ create: { width: w, height: h2, channels: 3, background: colour } }).jpeg().toBuffer();
const credit = { title: "Falafel", author: "A. Person", licence: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://commons.example.test/falafel" };

async function addRecipe(handle: DbHandle, slug: string): Promise<number> {
  const [row] = await handle.db.insert(s.recipes)
    .values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
    .returning({ id: s.recipes.id });
  return row!.id;
}

async function input(over: Partial<LibraryApproveInput> = {}): Promise<LibraryApproveInput> {
  return { candidateKey: "commons:one", origin: "commons", subjectKind: "recipe", subjectSlug: "falafel-bowl", bytes: await image(), credit, licenceCheckedAt: "2026-10-01T00:00:00.000Z", personId: null, ...over };
}
const sync = async (name: string) => (await h.db.select().from(s.syncState).where(eq(s.syncState.dataClass, name)))[0];

beforeEach(async () => {
  h = await openDb();
  store = createMemoryStore();
  await addRecipe(h, "falafel-bowl");
});

describe("approveLibraryCandidate", () => {
  it("stores a 1280 px master and 640 px thumb under library/ keys, a cover row, a decision and null-household sync marks", async () => {
    const result = await approveLibraryCandidate(h.db, store, await input());
    expect(result).toMatchObject({ status: "approved", isCover: true });
    const uid = (result as { uid: string }).uid;
    const keys = libraryPhotoKeys(uid);
    expect(keys).toEqual({ master: `library/${uid}/master.webp`, thumb: `library/${uid}/thumb.webp` });
    expect(await store.list()).toEqual([keys.master, keys.thumb].sort());
    const master = await sharp((await store.get(keys.master))!.bytes).metadata();
    const thumb = await sharp((await store.get(keys.thumb))!.bytes).metadata();
    expect([master.format, master.width, master.exif]).toEqual(["webp", 1280, undefined]);
    expect(thumb.width).toBe(640);
    const [row] = await h.db.select().from(s.libraryPhotos);
    expect(row).toMatchObject({ uid, origin: "commons", isCover: true, position: 0, width: 1280, height: 853, title: "Falafel", licenceCheckedAt: "2026-10-01T00:00:00.000Z" });
    expect(row!.recipeId).not.toBeNull();
    expect((await h.db.select().from(s.libraryPhotoDecisions))[0]).toMatchObject({ decision: "approved", subjectKind: "recipe", subjectSlug: "falafel-bowl", candidateKey: "commons:one" });
    expect((await sync("library-photos"))?.householdId).toBeNull();
    expect((await sync("library-photo-decisions"))?.householdId).toBeNull();
  });

  it("approves for an ingredient and refuses unknown subjects and incomplete credit", async () => {
    await h.db.insert(s.ingredients).values({ slug: "paneer", name: "Paneer", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, source: "USDA", sourceId: "x", aisle: "dairy", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: true });
    expect(await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:p" }))).toMatchObject({ status: "approved", isCover: true });
    expect(await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "nope" }))).toEqual({ status: "unknown-subject" });
    expect(await approveLibraryCandidate(h.db, store, await input({ subjectSlug: "nope" }))).toEqual({ status: "unknown-subject" });
    await expect(approveLibraryCandidate(h.db, store, await input({ credit: { ...credit, author: " " } }))).rejects.toBeInstanceOf(PhotoError);
    await expect(approveLibraryCandidate(h.db, store, await input({ bytes: Buffer.from("nope") }))).rejects.toBeInstanceOf(PhotoError);
    expect(store.size()).toBe(2);
  });

  it("gives one row, one cover and drops the losing files when two approvals race", async () => {
    const [a, b] = await Promise.all([approveLibraryCandidate(h.db, store, await input()), approveLibraryCandidate(h.db, store, await input())]);
    expect([a.status, b.status].sort()).toEqual(["approved", "exists"]);
    const rows = await h.db.select().from(s.libraryPhotos);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCover).toBe(true);
    expect(await store.list()).toEqual(Object.values(libraryPhotoKeys(rows[0]!.uid)).sort());
    expect(await h.db.select().from(s.libraryPhotoDecisions)).toHaveLength(1);
  });

  it("treats a conflict on the candidate index as a lost race even when the pre-check missed the rival", async () => {
    // A trigger plants the rival row inside the same transaction, after the duplicate pre-check and before the insert lands.
    await h.client.exec(`CREATE FUNCTION plant_rival() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO library_photos (uid, recipe_id, origin, candidate_key, sha256, width, height, title, author, licence, source_url, created_at, updated_at)
      VALUES ('rival', NEW.recipe_id, 'commons', NEW.candidate_key, repeat('0', 64), 1, 1, 't', 'a', 'l', 'u', now(), now());
      RETURN NEW; END $$;
      CREATE TRIGGER plant_rival BEFORE INSERT ON library_photos FOR EACH ROW WHEN (NEW.uid <> 'rival') EXECUTE FUNCTION plant_rival();`);
    expect(await approveLibraryCandidate(h.db, store, await input())).toEqual({ status: "exists", uid: "rival" });
    expect(store.size()).toBe(0);
    expect(await h.db.select().from(s.libraryPhotoDecisions)).toHaveLength(0);
  });

  it("makes the first photo the cover, later ones not, and refuses a fourth", async () => {
    const results = [];
    for (let i = 0; i < LIBRARY_PHOTO_CAP; i++) results.push(await approveLibraryCandidate(h.db, store, await input({ candidateKey: `commons:${i}`, bytes: await image(800, 600, `#00${i}000`) })));
    expect(results.map((r) => (r as { isCover: boolean }).isCover)).toEqual([true, false, false]);
    expect((await h.db.select().from(s.libraryPhotos).orderBy(s.libraryPhotos.position)).map((p) => p.position)).toEqual([0, 1, 2]);
    const before = store.size();
    expect(await approveLibraryCandidate(h.db, store, await input({ candidateKey: "commons:extra" }))).toEqual({ status: "subject-full" });
    expect(store.size()).toBe(before);
    expect(await h.db.select().from(s.libraryPhotoDecisions)).toHaveLength(3);
  });

  it("removes the files when the transaction fails, and when a thumbnail upload fails", async () => {
    await h.failWrite("library_photo_decisions", "INSERT", "boom_decisions");
    await expect(approveLibraryCandidate(h.db, store, await input())).rejects.toThrow();
    expect(store.size()).toBe(0);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(0);
    await h.dropFailure("library_photo_decisions", "boom_decisions");

    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, type) => {
      if (key.endsWith("/thumb.webp")) throw new Error("thumb failed");
      await put(key, bytes, type);
    });
    await expect(approveLibraryCandidate(h.db, store, await input())).rejects.toThrow("thumb failed");
    expect(store.size()).toBe(0);
  });

  it("reports a combined error when cleanup also fails", async () => {
    await h.failWrite("library_photos", "INSERT", "boom_photos");
    vi.spyOn(store, "delete").mockRejectedValue(new Error("delete failed"));
    await expect(approveLibraryCandidate(h.db, store, await input())).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("cover, removal and rejection", () => {
  async function three() {
    const uids: string[] = [];
    for (let i = 0; i < 3; i++) uids.push(((await approveLibraryCandidate(h.db, store, await input({ candidateKey: `commons:${i}`, bytes: await image(800, 600, `#00${i}000`) }))) as { uid: string }).uid);
    return uids;
  }
  const covers = async () => (await h.db.select({ uid: s.libraryPhotos.uid }).from(s.libraryPhotos).where(eq(s.libraryPhotos.isCover, true))).map((r) => r.uid);

  it("keeps one cover per subject at the database level", async () => {
    const [first] = await three();
    const row = (await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, first!)))[0]!;
    await expect(h.db.insert(s.libraryPhotos).values({ ...row, id: undefined, uid: "other", candidateKey: "commons:zzz" })).rejects.toThrow();
  });

  it("setLibraryCover swaps the cover and is a no-op for the current cover or a missing photo", async () => {
    const [first, second] = await three();
    expect(await setLibraryCover(h.db, first!)).toBe(true);
    expect(await setLibraryCover(h.db, second!)).toBe(true);
    expect(await covers()).toEqual([second]);
    expect(await setLibraryCover(h.db, "missing")).toBe(false);
  });

  it("setLibraryCover works for ingredient photos", async () => {
    await h.db.insert(s.ingredients).values({ slug: "paneer", name: "Paneer", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, source: "USDA", sourceId: "x", aisle: "dairy", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: true });
    const a = await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:a" })) as { uid: string };
    const b = await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:b" })) as { uid: string };
    expect(await setLibraryCover(h.db, b.uid)).toBe(true);
    expect(await covers()).toEqual([b.uid]);
    expect(await removeLibraryPhoto(h.db, store, b.uid, null)).toBe(true);
    expect(await covers()).toEqual([a.uid]);
    expect((await h.db.select().from(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.decision, "rejected")))[0]).toMatchObject({ subjectKind: "ingredient", subjectSlug: "paneer" });
  });

  it("removeLibraryPhoto promotes the next cover, records rejected and deletes files after commit", async () => {
    const [first, second] = await three();
    expect(await removeLibraryPhoto(h.db, store, first!, 7 as never)).toBe(true);
    expect(await covers()).toEqual([second]);
    expect((await h.db.select().from(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.candidateKey, "commons:0")))[0]).toMatchObject({ decision: "rejected" });
    expect(await store.list()).not.toContain(libraryPhotoKeys(first!).master);
    expect(await removeLibraryPhoto(h.db, store, first!, null)).toBe(false);
    // removing a non-cover leaves the cover alone
    const [, , third] = [first, second, (await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.candidateKey, "commons:2")))[0]!.uid];
    expect(await removeLibraryPhoto(h.db, store, third!, null)).toBe(true);
    expect(await covers()).toEqual([second]);
    // removing the last photo leaves no cover
    expect(await removeLibraryPhoto(h.db, store, second!, null)).toBe(true);
    expect(await covers()).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it("surfaces a storage cleanup failure after the row is gone", async () => {
    const [first] = await three();
    vi.spyOn(store, "delete").mockRejectedValue(new Error("nope"));
    await expect(removeLibraryPhoto(h.db, store, first!, null)).rejects.toBeInstanceOf(AggregateError);
    expect(await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.uid, first!))).toHaveLength(0);
  });

  it("rejectLibraryCandidates upserts in one transaction, skips live photos and unknown recipes, and undo reverses it", async () => {
    await approveLibraryCandidate(h.db, store, await input({ candidateKey: "commons:live" }));
    const refs = [
      { candidateKey: "commons:x", subjectKind: "recipe" as const, subjectSlug: "falafel-bowl" },
      { candidateKey: "commons:x", subjectKind: "recipe" as const, subjectSlug: "falafel-bowl" },
      { candidateKey: "commons:live", subjectKind: "recipe" as const, subjectSlug: "falafel-bowl" },
      { candidateKey: "commons:y", subjectKind: "recipe" as const, subjectSlug: "gone" },
      { candidateKey: "commons:i", subjectKind: "ingredient" as const, subjectSlug: "paneer" },
    ];
    expect(await rejectLibraryCandidates(h.db, [], null)).toBe(0);
    expect(await rejectLibraryCandidates(h.db, refs, null)).toBe(2);
    expect(await rejectLibraryCandidates(h.db, refs.slice(0, 1), null)).toBe(1);
    expect(await rejectLibraryCandidates(h.db, [refs[2]!], null)).toBe(0);
    const rejected = await h.db.select().from(s.libraryPhotoDecisions).where(eq(s.libraryPhotoDecisions.decision, "rejected"));
    expect(rejected.map((d) => d.candidateKey).sort()).toEqual(["commons:i", "commons:x"]);
    expect(await undoLibraryRejection(h.db, refs[0]!)).toBe(true);
    expect(await undoLibraryRejection(h.db, refs[0]!)).toBe(false);
    expect(await undoLibraryRejection(h.db, { candidateKey: "commons:live", subjectKind: "recipe", subjectSlug: "falafel-bowl" })).toBe(false);
  });

  it("a rejected candidate can be approved later", async () => {
    await rejectLibraryCandidates(h.db, [{ candidateKey: "commons:one", subjectKind: "recipe", subjectSlug: "falafel-bowl" }], null);
    expect((await approveLibraryCandidate(h.db, store, await input())).status).toBe("approved");
    expect((await h.db.select().from(s.libraryPhotoDecisions))[0]!.decision).toBe("approved");
  });
});

describe("export and import", () => {
  it("round-trips both classes byte for byte and lists blobs with sha256", async () => {
    const a = await approveLibraryCandidate(h.db, store, await input()) as { uid: string };
    await approveLibraryCandidate(h.db, store, await input({ candidateKey: "commons:two", bytes: await image(900, 900, "#112233"), licenceCheckedAt: null }));
    await rejectLibraryCandidates(h.db, [{ candidateKey: "commons:no", subjectKind: "recipe", subjectSlug: "falafel-bowl" }], null);
    const names = ["library-photos", "library-photo-decisions"];
    const first = await exportHumanData(h.db, names);
    expect(Object.keys(first.files).every((p) => p.startsWith("library-photos/") || p.startsWith("library-photo-decisions/"))).toBe(true);
    expect(Object.keys(first.files).some((p) => p.startsWith(`library-photos/recipes/falafel-bowl/${a.uid}`))).toBe(true);
    expect(JSON.stringify(first.files)).not.toMatch(/"id"|household/);

    const fresh = await openDb();
    await addRecipe(fresh, "falafel-bowl");
    const report = await importHumanData(fresh.db, first);
    expect(report.imported).toMatchObject({ "library-photos": 2, "library-photo-decisions": 3 });
    const second = await exportHumanData(fresh.db, names);
    expect(second).toEqual(first);
    // idempotent re-import
    await importHumanData(fresh.db, first);
    expect(await exportHumanData(fresh.db, names)).toEqual(first);

    const refs = await libraryPhotosClass.blobs!(h.db);
    const rows = await h.db.select().from(s.libraryPhotos);
    expect(refs).toHaveLength(4);
    for (const r of rows) {
      expect(refs).toContainEqual({ key: libraryPhotoKeys(r.uid).master, sha256: r.sha256 });
      expect(refs).toContainEqual({ key: libraryPhotoKeys(r.uid).thumb });
    }
  });

  it("imports ingredient photos, moves a changed cover without tripping the index, and skips unknown recipes", async () => {
    await h.db.insert(s.ingredients).values({ slug: "paneer", name: "Paneer", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, source: "USDA", sourceId: "x", aisle: "dairy", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: true });
    const a = await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:a" })) as { uid: string };
    const b = await approveLibraryCandidate(h.db, store, await input({ subjectKind: "ingredient", subjectSlug: "paneer", candidateKey: "commons:b" })) as { uid: string };
    const before = await exportHumanData(h.db, ["library-photos"]);
    await setLibraryCover(h.db, b.uid);
    const after = await exportHumanData(h.db, ["library-photos"]);
    // apply the older state, then the newer one, onto the same database
    await importHumanData(h.db, before);
    expect((await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.isCover, true))).map((r) => r.uid)).toEqual([a.uid]);
    await importHumanData(h.db, after);
    expect((await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.isCover, true))).map((r) => r.uid)).toEqual([b.uid]);

    const file = Object.entries(after.files)[0]!;
    const orphan = { ...after, files: { "library-photos/recipes/gone/x.json": file[1].replace('"kind": "ingredient"', '"kind": "recipe"').replace('"slug": "paneer"', '"slug": "gone"') } };
    expect((await importHumanData(h.db, orphan)).skipped).toEqual(["library-photos/recipes/gone/x.json"]);
  });
});

describe("slug renames", () => {
  async function seedTwo() {
    const oldId = (await h.db.select({ id: s.recipes.id }).from(s.recipes))[0]!.id;
    return oldId;
  }

  it("an in-place rename rewrites slug-keyed library decisions; photos follow by id", async () => {
    await approveLibraryCandidate(h.db, store, await input());
    await rejectLibraryCandidates(h.db, [{ candidateKey: "commons:no", subjectKind: "recipe", subjectSlug: "falafel-bowl" }], null);
    await applyRenames(h.db, { "falafel-bowl": "falafel-plate" });
    expect((await h.db.select().from(s.recipes))[0]!.slug).toBe("falafel-plate");
    expect((await h.db.select().from(s.libraryPhotoDecisions)).map((d) => d.subjectSlug)).toEqual(["falafel-plate", "falafel-plate"]);
    const files = await libraryPhotosClass.exportFiles(h.db);
    expect(Object.keys(files)[0]).toContain("library-photos/recipes/falafel-plate/");
  });

  it("a rename onto an existing recipe moves photos (cap, duplicates, cover) and decisions", async () => {
    const oldId = await seedTwo();
    const newId = await addRecipe(h, "falafel-plate");
    for (const i of [0, 1, 2]) await approveLibraryCandidate(h.db, store, await input({ candidateKey: `commons:${i}`, bytes: await image(800, 600, `#00${i}000`) }));
    await approveLibraryCandidate(h.db, store, await input({ subjectSlug: "falafel-plate", candidateKey: "commons:1", bytes: await image(700, 500, "#ff0000") }));
    await rejectLibraryCandidates(h.db, [{ candidateKey: "commons:r", subjectKind: "recipe", subjectSlug: "falafel-bowl" }, { candidateKey: "commons:1", subjectKind: "recipe", subjectSlug: "falafel-bowl" }], null);
    await rejectLibraryCandidates(h.db, [{ candidateKey: "commons:1", subjectKind: "recipe", subjectSlug: "falafel-plate" }], null);
    // commons:1 is live on the target, so the target's rejection was skipped; the old recipe's rejection of commons:1 collides on rename
    await applyRenames(h.db, { "falafel-bowl": "falafel-plate" });
    const target = await h.db.select().from(s.libraryPhotos).where(eq(s.libraryPhotos.recipeId, newId));
    expect(target.map((p) => p.candidateKey).sort()).toEqual(["commons:0", "commons:1", "commons:2"].filter((k) => k !== "commons:2" || target.length === 3));
    expect(target.filter((p) => p.isCover)).toHaveLength(1);
    expect(target.length).toBeLessThanOrEqual(LIBRARY_PHOTO_CAP);
    expect(await libraryPhotosClass.hasRecipeData!(h.db, oldId)).toBe(true);
    const slugs = await h.db.select().from(s.libraryPhotoDecisions).where(and(eq(s.libraryPhotoDecisions.subjectSlug, "falafel-plate"), eq(s.libraryPhotoDecisions.decision, "rejected")));
    expect(slugs.map((d) => d.candidateKey)).toContain("commons:r");
  });

  it("decision moves are a no-op when a recipe row is missing or has no decisions", async () => {
    expect(await libraryPhotoDecisionsClass.moveRecipe!(h.db, 9998, 9999)).toBe(false);
    const id = (await h.db.select({ id: s.recipes.id }).from(s.recipes))[0]!.id;
    const other = await addRecipe(h, "other");
    expect(await libraryPhotoDecisionsClass.moveRecipe!(h.db, id, other)).toBe(false);
    expect(await libraryPhotosClass.moveRecipe!(h.db, id, other)).toBe(false);
  });
});

describe("safety around household resets and checks", () => {
  async function withHouseholdAndLibrary() {
    await h.db.insert(s.households).values({ id: "a", name: "First" });
    const [person] = await h.db.insert(s.people).values({ householdId: "a", name: "Cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] }).returning({ id: s.people.id });
    await h.db.insert(s.authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ userId: "owner", householdId: "a", personId: person!.id, role: "owner" });
    const recipeId = (await h.db.select({ id: s.recipes.id }).from(s.recipes))[0]!.id;
    await h.db.insert(s.photos).values({ householdId: "a", uid: "own-photo", recipeId, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" });
    for (const k of Object.values(photoKeys("own-photo"))) await store.put(k, Buffer.from("x"), "image/webp");
    const lib = await approveLibraryCandidate(h.db, store, await input({ personId: person!.id })) as { uid: string };
    return { personId: person!.id, lib };
  }

  it("resetData('all') clears photos/ keys and rows but keeps library rows and files", async () => {
    const { lib } = await withHouseholdAndLibrary();
    await store.put("other/thing.bin", Buffer.from("x"), "application/octet-stream");
    await resetData(h.db, "all", store);
    expect(await store.list()).toEqual([...Object.values(libraryPhotoKeys(lib.uid)), "other/thing.bin"].sort());
    expect(await h.db.select().from(s.photos)).toHaveLength(0);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(1);
    expect(await h.db.select().from(s.libraryPhotoDecisions)).toHaveLength(1);
  });

  it("household reset 'all' and household deletion leave library rows and files alone and null the person link", async () => {
    const { lib } = await withHouseholdAndLibrary();
    const access = await resolveHouseholdAccess(h.db, "owner", "a");
    await resetHouseholdData(h.db, access, "all", store);
    expect(await store.list()).toEqual(Object.values(libraryPhotoKeys(lib.uid)).sort());
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(1);
    // the person went with the reset, so the author link is null and the rows remain
    expect((await h.db.select().from(s.libraryPhotos))[0]!.createdByPersonId).toBeNull();
    expect((await h.db.select().from(s.libraryPhotoDecisions))[0]!.createdByPersonId).toBeNull();

    const keys = await h.db.transaction((tx) => deleteHousehold(tx, "a"));
    expect(keys.every((k) => k.startsWith("photos/"))).toBe(true);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(1);
  });

  it("deleting a person sets created_by_person_id to null", async () => {
    const { personId } = await withHouseholdAndLibrary();
    expect((await h.db.select().from(s.libraryPhotos))[0]!.createdByPersonId).toBe(personId);
    await h.db.delete(s.householdMembers);
    await h.db.delete(s.people).where(eq(s.people.id, personId));
    expect((await h.db.select().from(s.libraryPhotos))[0]!.createdByPersonId).toBeNull();
    expect((await h.db.select().from(s.libraryPhotoDecisions))[0]!.createdByPersonId).toBeNull();
  });

  it("checkPhotos reports library orphans and missing files, and a delete of orphans keeps live library files", async () => {
    const lib = await approveLibraryCandidate(h.db, store, await input()) as { uid: string };
    expect(await checkPhotos(h.db, store)).toEqual({ orphans: [], missing: [] });
    await store.put("library/dead/master.webp", Buffer.from("x"), "image/webp");
    await store.delete(libraryPhotoKeys(lib.uid).thumb);
    const report = await checkPhotos(h.db, store);
    expect(report.orphans).toEqual(["library/dead/master.webp"]);
    expect(report.missing).toEqual([{ uid: lib.uid, keys: [libraryPhotoKeys(lib.uid).thumb] }]);
    for (const o of report.orphans) await store.delete(o);
    expect(await store.list()).toEqual([libraryPhotoKeys(lib.uid).master]);
  });
});
