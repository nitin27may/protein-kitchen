import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import { applyRenames } from "../lib/db/renames";
import * as s from "../lib/db/schema";
import { approveCandidate, copyHumanBlobs, deletePhoto, exportHumanData, importHumanData, rejectCandidate, setCoverPhoto, writeUploadedPhoto } from "../lib/human";
import { photoKeys } from "../lib/photos/keys";
import { PhotoError } from "../lib/photos/process";
import { resetCounts, resetData } from "../lib/server/reset";

const migrations = path.resolve(__dirname, "..", "db", "migrations");

let a: DbHandle;
let store: ReturnType<typeof createMemoryStore>;

const jpeg = (w = 800, h = 600, colour = "#c87828") => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();

async function addRecipe(h: DbHandle, slug: string): Promise<number> {
  const [row] = await h.db
    .insert(s.recipes)
    .values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
    .returning({ id: s.recipes.id });
  return row!.id;
}
const syncOf = async (cls: string) => (await a.db.select().from(s.syncState).where(eq(s.syncState.dataClass, cls)))[0];

beforeEach(async () => {
  a = await openDb();
  store = createMemoryStore();
});

describe("writeUploadedPhoto", () => {
  it("stores both sizes under keys from the uid, records the row and marks the class changed", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const { uid } = await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg(), personId: null });
    const keys = photoKeys(uid);
    expect(await store.list()).toEqual([keys.master, keys.thumb].sort());
    const [row] = await a.db.select().from(s.photos);
    expect(row).toMatchObject({ uid, recipeId: id, origin: "upload", isCover: true, position: 0, width: 800, height: 600 });
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.createdAt).toBeTruthy();
    expect(await syncOf("photos")).toBeTruthy();
  });

  it("rejects a bad file without leaving a row or a blob", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    await expect(writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: Buffer.from("nope") })).rejects.toBeInstanceOf(PhotoError);
    expect(await a.db.select().from(s.photos)).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it("removes the blobs again when the row cannot be written", async () => {
    // A recipe id that does not exist breaks the foreign key inside the transaction.
    await expect(writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: 9999 }, bytes: await jpeg() })).rejects.toThrow();
    expect(store.size()).toBe(0);
  });
  it("cleans up the master when thumbnail upload fails before the database transaction", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, type) => {
      if (key.endsWith("/thumb.webp")) throw new Error("synthetic thumbnail upload failure");
      await put(key, bytes, type);
    });
    await expect(writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg() })).rejects.toThrow("thumbnail upload failure");
    expect(store.size()).toBe(0);
    expect(await a.db.select().from(s.photos)).toEqual([]);
    expect(await syncOf("photos")).toBeUndefined();
  });
  it("reports original and cleanup failures and attempts both object deletions", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    vi.spyOn(store, "put").mockRejectedValue(new Error("synthetic upload failure"));
    const remove = vi.spyOn(store, "delete").mockRejectedValue(new Error("synthetic cleanup failure"));
    const failure = await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg() }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors[0].message).toBe("synthetic upload failure");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await a.db.select().from(s.photos)).toEqual([]);
  });

  it("makes the first photo the cover, and moves cover and order with later ones", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const subject = { kind: "recipe" as const, recipeId: id };
    const one = await writeUploadedPhoto(a.db, store, { subject, bytes: await jpeg() });
    const two = await writeUploadedPhoto(a.db, store, { subject, bytes: await jpeg(700, 500, "#336699") });
    let rows = await a.db.select().from(s.photos).orderBy(s.photos.position);
    expect(rows.map((r) => [r.uid, r.isCover, r.position])).toEqual([[one.uid, true, 0], [two.uid, false, 1]]);
    expect(await setCoverPhoto(a.db, two.uid)).toBe(true);
    rows = await a.db.select().from(s.photos).orderBy(s.photos.position);
    expect(rows.map((r) => r.isCover)).toEqual([false, true]);
    expect(await setCoverPhoto(a.db, "missing")).toBe(false);
  });
});

describe("candidates", () => {
  const credit = { title: "Falafel", author: "A. Photographer", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/", sourceUrl: "https://commons.wikimedia.org/wiki/File:Falafel.jpg" };

  it("approving records the photo, its credit and the approval together, and is idempotent", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const input = { candidateKey: "commons:File:Falafel.jpg", provider: "commons" as const, subject: { kind: "recipe" as const, recipeId: id }, subjectSlug: "falafel-bowl", bytes: await jpeg(), credit };
    const first = await approveCandidate(a.db, store, input);
    const again = await approveCandidate(a.db, store, input);
    expect(again).toEqual(first);
    const [row] = await a.db.select().from(s.photos);
    expect(row).toMatchObject({ origin: "commons", author: "A. Photographer", licence: "CC BY-SA 4.0", candidateKey: "commons:File:Falafel.jpg", isCover: true });
    expect((await a.db.select().from(s.photoDecisions))[0]).toMatchObject({ candidateKey: "commons:File:Falafel.jpg", decision: "approved", subjectKind: "recipe", subjectSlug: "falafel-bowl" });
    expect(await syncOf("photo-decisions")).toBeTruthy();
  });

  it("an own photo takes the cover from an approved candidate, never the other way round", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const subject = { kind: "recipe" as const, recipeId: id };
    const cand = await approveCandidate(a.db, store, { candidateKey: "commons:a", provider: "commons", subject, subjectSlug: "falafel-bowl", bytes: await jpeg(), credit });
    const own = await writeUploadedPhoto(a.db, store, { subject, bytes: await jpeg(600, 600, "#336699") });
    let rows = await a.db.select().from(s.photos);
    expect(rows.find((r) => r.uid === own.uid)!.isCover).toBe(true);
    expect(rows.find((r) => r.uid === cand.uid)!.isCover).toBe(false);
    await approveCandidate(a.db, store, { candidateKey: "commons:b", provider: "commons", subject, subjectSlug: "falafel-bowl", bytes: await jpeg(500, 500, "#aa3333"), credit });
    rows = await a.db.select().from(s.photos);
    expect(rows.filter((r) => r.isCover).map((r) => r.uid)).toEqual([own.uid]);
  });

  it("rejecting records the decision; deleting an approved photo turns it into a rejection", async () => {
    await rejectCandidate(a.db, { candidateKey: "commons:no", kind: "ingredient", slug: "tofu-extra-firm" });
    expect((await a.db.select().from(s.photoDecisions))[0]).toMatchObject({ decision: "rejected", subjectKind: "ingredient", subjectSlug: "tofu-extra-firm" });

    const approved = await approveCandidate(a.db, store, { candidateKey: "commons:yes", provider: "commons", subject: { kind: "ingredient", slug: "tofu-extra-firm" }, subjectSlug: "tofu-extra-firm", bytes: await jpeg(), credit });
    expect((await a.db.select().from(s.photoDecisions).where(eq(s.photoDecisions.candidateKey, "commons:yes")))[0]!.decision).toBe("approved");
    expect(await deletePhoto(a.db, store, approved.uid)).toBe(true);
    expect((await a.db.select().from(s.photoDecisions).where(eq(s.photoDecisions.candidateKey, "commons:yes")))[0]!.decision).toBe("rejected");
    expect(store.size()).toBe(0);
  });
});

describe("deletePhoto", () => {
  it("removes the bytes and promotes the next photo to cover", async () => {
    const id = await addRecipe(a, "falafel-bowl");
    const subject = { kind: "recipe" as const, recipeId: id };
    const one = await writeUploadedPhoto(a.db, store, { subject, bytes: await jpeg() });
    const two = await writeUploadedPhoto(a.db, store, { subject, bytes: await jpeg(700, 500, "#336699") });
    expect(await deletePhoto(a.db, store, one.uid)).toBe(true);
    expect(await deletePhoto(a.db, store, one.uid)).toBe(false);
    const rows = await a.db.select().from(s.photos);
    expect(rows.map((r) => [r.uid, r.isCover])).toEqual([[two.uid, true]]);
    expect(await store.exists(photoKeys(one.uid).master)).toBe(false);
    expect(await store.exists(photoKeys(two.uid).master)).toBe(true);
  });

  it("is deleted with its recipe row (cascade) but the check allows only one subject", async () => {
    await expect(a.db.insert(s.photos).values({ uid: "x", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "t", updatedAt: "t" })).rejects.toThrow();
    const id = await addRecipe(a, "r");
    await expect(a.db.insert(s.photos).values({ uid: "y", recipeId: id, ingredientSlug: "tofu", origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: "t", updatedAt: "t" })).rejects.toThrow();
  });
});

describe("export and import", () => {
  async function seedPhotos() {
    const falafel = await addRecipe(a, "falafel-bowl");
    await addRecipe(a, "other");
    await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: falafel }, bytes: await jpeg() });
    await approveCandidate(a.db, store, { candidateKey: "openverse:42", provider: "openverse", subject: { kind: "ingredient", slug: "tofu-extra-firm" }, subjectSlug: "tofu-extra-firm", bytes: await jpeg(640, 480, "#336699"), credit: { title: "Tofu", author: "B", licence: "CC0", licenceUrl: null, sourceUrl: "https://openverse.org/image/42" } });
    await rejectCandidate(a.db, { candidateKey: "commons:no", kind: "recipe", slug: "other" });
  }

  it("round trips byte for byte into a fresh database whose recipe ids differ, with the bytes copied and checked", async () => {
    await seedPhotos();
    const first = await exportHumanData(a.db);
    const paths = Object.keys(first.files).filter((p) => p.startsWith("photo"));
    expect(paths.some((p) => /^photos\/recipes\/falafel-bowl\/[0-9a-f-]{36}\.json$/.test(p))).toBe(true);
    expect(paths.some((p) => /^photos\/ingredients\/tofu-extra-firm\/[0-9a-f-]{36}\.json$/.test(p))).toBe(true);
    expect(paths.some((p) => p.startsWith("photo-decisions/recipes/other/"))).toBe(true);
    for (const p of paths) {
      const text = first.files[p]!;
      expect(Object.keys(JSON.parse(text))).not.toContain("recipe_id");
      expect(text).not.toMatch(/"id":/);
    }

    const b = await openDb();
    const storeB = createMemoryStore();
    await addRecipe(b, "shifts-every-id");
    await addRecipe(b, "falafel-bowl");
    await addRecipe(b, "other");
    const report = await importHumanData(b.db, first, { renames: {} });
    expect(report.skipped).toEqual([]);
    expect(report.imported["photos"]).toBe(2);
    expect(report.imported["photo-decisions"]).toBe(2);

    const copy = await copyHumanBlobs(a.db, store, storeB);
    expect(copy).toEqual({ copied: 4, missing: [], corrupt: [] });
    expect(await storeB.list()).toEqual(await store.list());

    const second = await exportHumanData(b.db);
    expect(second.files).toEqual(first.files);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("is idempotent, and a copy refuses bytes that do not match the recorded sha256", async () => {
    await seedPhotos();
    const bundle = await exportHumanData(a.db);
    const b = await openDb();
    await addRecipe(b, "falafel-bowl");
    await addRecipe(b, "other");
    await importHumanData(b.db, bundle, { renames: {} });
    const once = await exportHumanData(b.db);
    await importHumanData(b.db, bundle, { renames: {} });
    expect(await exportHumanData(b.db)).toEqual(once);

    const [row] = await a.db.select().from(s.photos).where(eq(s.photos.origin, "upload"));
    await store.put(photoKeys(row!.uid).master, new Uint8Array([1, 2, 3]), "image/webp");
    const copy = await copyHumanBlobs(a.db, store, createMemoryStore());
    expect(copy.corrupt).toEqual([photoKeys(row!.uid).master]);
  });

  it("skips a recipe photo whose recipe is gone, unless a rename points at it", async () => {
    await seedPhotos();
    const bundle = await exportHumanData(a.db);
    const b = await openDb();
    await addRecipe(b, "renamed-bowl");
    expect((await importHumanData(b.db, bundle, { renames: {} })).skipped.some((p) => p.startsWith("photos/recipes/falafel-bowl/"))).toBe(true);
    const ok = await importHumanData(b.db, bundle, { renames: { "falafel-bowl": "renamed-bowl" } });
    expect(ok.skipped.some((p) => p.startsWith("photos/recipes/falafel-bowl/"))).toBe(false);
  });
});

describe("renames and reset", () => {
  it("a slug rename moves the photos to the new recipe row", async () => {
    const oldId = await addRecipe(a, "old-bowl");
    const newId = await addRecipe(a, "new-bowl");
    const one = await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: oldId }, bytes: await jpeg() });
    expect(await applyRenames(a.db, { "old-bowl": "new-bowl" })).toEqual({ moved: ["old-bowl"] });
    expect((await a.db.select().from(s.photos))[0]).toMatchObject({ uid: one.uid, recipeId: newId, isCover: true });
    expect(await a.db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, "old-bowl"))).toHaveLength(0);
  });

  it("only Everything clears photos, their approvals and their files", async () => {
    const id = await addRecipe(a, "r");
    await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg() });
    await rejectCandidate(a.db, { candidateKey: "commons:x", kind: "recipe", slug: "r" });
    expect((await resetCounts(a.db)).photos).toBe(1);
    for (const scope of ["plans", "groceries", "progress", "ratings", "profiles"] as const) await resetData(a.db, scope, store);
    expect(await a.db.select().from(s.photos)).toHaveLength(1);
    expect(store.size()).toBe(2);
    await resetData(a.db, "all", store);
    expect(await a.db.select().from(s.photos)).toHaveLength(0);
    expect(await a.db.select().from(s.photoDecisions)).toHaveLength(0);
    expect(store.size()).toBe(0);
    expect((await syncOf("photos"))).toBeTruthy();
  });
});

describe("photo actions", () => {
  it("validate size, type and recipe, and cap photos per recipe", async () => {
    const { addRecipePhotoChecked, makeCoverChecked, removePhotoChecked, MAX_PHOTOS_PER_RECIPE } = await import("../lib/server/photo-actions");
    await addRecipe(a, "falafel-bowl");
    expect(await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: new Uint8Array() })).toEqual({ ok: false, error: "Choose a photo first." });
    expect(await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: Buffer.from("not an image") })).toMatchObject({ ok: false });
    expect(await addRecipePhotoChecked(a.db, store, { recipeSlug: "nope", bytes: await jpeg() })).toEqual({ ok: false, error: "Recipe not found." });
    expect(store.size()).toBe(0);

    const first = await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: await jpeg() });
    if (!first.ok) throw new Error("expected ok");
    const second = await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: await jpeg(500, 500, "#336699") });
    if (!second.ok) throw new Error("expected ok");
    expect(await makeCoverChecked(a.db, second.uid)).toEqual({ ok: true, recipeSlug: "falafel-bowl" });
    expect(await makeCoverChecked(a.db, "not-a-uid")).toMatchObject({ ok: false });
    expect(await removePhotoChecked(a.db, store, first.uid)).toEqual({ ok: true, recipeSlug: "falafel-bowl" });
    expect(await removePhotoChecked(a.db, store, first.uid)).toMatchObject({ ok: false });

    for (let i = 1; i < MAX_PHOTOS_PER_RECIPE; i++) await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: await jpeg(100 + i, 100) });
    expect(await addRecipePhotoChecked(a.db, store, { recipeSlug: "falafel-bowl", bytes: await jpeg() })).toMatchObject({ ok: false });
  });
});

describe("photo review", () => {
  const file = (key = "commons:File:Falafel.jpg"): import("../lib/photos/candidates").CandidateFile => ({
    recipes: { "falafel-bowl": [{ key, provider: "commons", title: "Falafel", author: "A", licence: "CC BY-SA 4.0", licence_url: null, source_url: "https://commons.wikimedia.org/wiki/File:Falafel.jpg", image_url: "https://upload.wikimedia.org/x/Falafel.jpg", width: 1200, height: 800 }] },
    ingredients: { "tofu-extra-firm": [{ key: "openverse:abc", provider: "openverse", title: "Tofu", author: "B", licence: "CC0 1.0", licence_url: null, source_url: "https://www.flickr.com/photos/1/2", image_url: "https://api.openverse.org/v1/images/abc/thumb/", width: 1200, height: 800 }] },
  });
  const names = { recipes: new Map([["falafel-bowl", "Baked falafel bowl"]]), ingredients: new Map([["tofu-extra-firm", "Tofu"]]) };

  it("lists pending candidates, hides decided ones, and filters", async () => {
    const { pendingReview, rejectCandidateChecked } = await import("../lib/server/photo-review");
    await addRecipe(a, "falafel-bowl");
    expect((await pendingReview(a.db, file(), names)).map((i) => i.slug)).toEqual(["falafel-bowl", "tofu-extra-firm"]);
    expect((await pendingReview(a.db, file(), names, { kind: "ingredient" })).map((i) => i.slug)).toEqual(["tofu-extra-firm"]);
    expect((await pendingReview(a.db, file(), names, { q: "falafel" })).map((i) => i.slug)).toEqual(["falafel-bowl"]);
    expect(await rejectCandidateChecked(a.db, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:File:Falafel.jpg" })).toMatchObject({ ok: true });
    expect((await pendingReview(a.db, file(), names)).map((i) => i.slug)).toEqual(["tofu-extra-firm"]);
    expect(await rejectCandidateChecked(a.db, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:nope" })).toMatchObject({ ok: false });
  });

  it("rejects a shared candidate per subject and safely retries the same rejection", async () => {
    const { pendingReview, rejectCandidateChecked } = await import("../lib/server/photo-review");
    const candidates = file();
    const shared = candidates.recipes["falafel-bowl"]![0]!;
    candidates.ingredients["tofu-extra-firm"] = [shared];
    const input = { kind: "recipe" as const, slug: "falafel-bowl", key: shared.key };

    expect(await rejectCandidateChecked(a.db, candidates, input)).toMatchObject({ ok: true });
    expect(await rejectCandidateChecked(a.db, candidates, input)).toMatchObject({ ok: true });
    expect(await a.db.select().from(s.photoDecisions)).toHaveLength(1);
    expect((await pendingReview(a.db, candidates, names)).map((i) => i.slug)).toEqual(["tofu-extra-firm"]);

    expect(await rejectCandidateChecked(a.db, candidates, { ...input, kind: "ingredient", slug: "tofu-extra-firm" })).toMatchObject({ ok: true });
    expect(await pendingReview(a.db, candidates, names)).toEqual([]);
    expect(await a.db.select().from(s.photoDecisions)).toHaveLength(2);
  });

  it("approves from the server's own list: licence rechecked, image fetched from the listed URL, never a client URL", async () => {
    const { approveCandidateChecked, pendingReview } = await import("../lib/server/photo-review");
    await addRecipe(a, "falafel-bowl");
    const image = await jpeg(1400, 900);
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.includes("commons.wikimedia.org")) return new Response(JSON.stringify({ query: { pages: { "1": { imageinfo: [{ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] } } } }), { status: 200 });
      return new Response(new Uint8Array(image), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await approveCandidateChecked(a.db, store, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:File:Falafel.jpg" }, { fetchImpl: fake });
    expect(r).toEqual({ ok: true, recipeSlug: "falafel-bowl" });
    expect(seen[1]).toBe("https://upload.wikimedia.org/x/Falafel.jpg");
    expect((await a.db.select().from(s.photos))[0]).toMatchObject({ origin: "commons", author: "A", licence: "CC BY-SA 4.0", candidateKey: "commons:File:Falafel.jpg" });
    expect((await pendingReview(a.db, file(), names, { kind: "recipe" })).length).toBe(0);
  });

  it("refuses when the licence changed, the image cannot be fetched, or the key is unknown", async () => {
    const { approveCandidateChecked } = await import("../lib/server/photo-review");
    await addRecipe(a, "falafel-bowl");
    const nc = (async () => new Response(JSON.stringify({ query: { pages: { "1": { imageinfo: [{ extmetadata: { LicenseShortName: { value: "CC BY-NC 4.0" } } }] } } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await approveCandidateChecked(a.db, store, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:File:Falafel.jpg" }, { fetchImpl: nc })).toMatchObject({ ok: false });
    const down = (async (url: string) => (url.includes("commons.wikimedia.org") ? new Response(JSON.stringify({ query: { pages: { "1": { imageinfo: [{ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] } } } }), { status: 200 }) : new Response("no", { status: 404 }))) as unknown as typeof fetch;
    expect(await approveCandidateChecked(a.db, store, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:File:Falafel.jpg" }, { fetchImpl: down })).toMatchObject({ ok: false, error: expect.stringContaining("404") });
    expect(await approveCandidateChecked(a.db, store, file(), { kind: "recipe", slug: "falafel-bowl", key: "commons:made-up" })).toMatchObject({ ok: false });
    expect(await a.db.select().from(s.photos)).toHaveLength(0);
    expect(store.size()).toBe(0);
  });
});

describe("checkPhotos", () => {
  it("finds files no row points at and rows whose files are gone", async () => {
    const { checkPhotos } = await import("../lib/photos/check");
    const id = await addRecipe(a, "falafel-bowl");
    const kept = await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg() });
    const lost = await writeUploadedPhoto(a.db, store, { subject: { kind: "recipe", recipeId: id }, bytes: await jpeg(500, 400, "#336699") });
    await store.put("photos/00000000-0000-4000-8000-000000000000/master.webp", new Uint8Array([1]), "image/webp");
    await store.delete(photoKeys(lost.uid).thumb);
    const report = await checkPhotos(a.db, store);
    expect(report.orphans).toEqual(["photos/00000000-0000-4000-8000-000000000000/master.webp"]);
    expect(report.missing).toEqual([{ uid: lost.uid, keys: [photoKeys(lost.uid).thumb] }]);
    expect(report.missing.some((m) => m.uid === kept.uid)).toBe(false);
  });
});
