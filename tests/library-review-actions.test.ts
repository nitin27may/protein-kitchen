import path from "node:path";
import sharp from "sharp";
import { revalidatePath, updateTag } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { curatorDenial } from "../lib/auth/curator";
import { requireMember } from "../lib/auth/access";
import { setBlobStore } from "../lib/blob";
import { createMemoryStore } from "../lib/blob/memory";
import * as s from "../lib/db/schema";
import { approveLibraryCandidate } from "../lib/human/library-photos";
import { loadCandidates } from "../lib/photos/candidates";
import { getData, getDb } from "../lib/server/context";
import { openDb, type DbHandle } from "./helpers/db";
import * as actions from "../app/photos/review/actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("../lib/auth/curator", () => ({ curatorDenial: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ requireMember: vi.fn() }));
vi.mock("../lib/server/context", () => ({ getDb: vi.fn(), getData: vi.fn() }));
vi.mock("../lib/photos/candidates", async (original) => ({ ...(await original<typeof import("../lib/photos/candidates")>()), loadCandidates: vi.fn() }));

const denied = { ok: false as const, error: "Only photo curators can do that." };
const UID = "0d4f1b1c-7a6e-4a53-8d0b-2f6f7f5a3c11";
const cand = (key: string, image: string, provider: "commons" | "openverse", licence: string) => ({ key, provider, title: "T", author: "A", licence, licence_url: null, source_url: "https://commons.wikimedia.org/wiki/File:X.jpg", image_url: `https://upload.wikimedia.org/x/${image}`, width: 10, height: 10 });
const falafel = cand("commons:File:Fixture Falafel.jpg", "falafel.jpg", "commons", "CC BY-SA 4.0");
const tofu = cand("openverse:fixture-tofu", "tofu.jpg", "openverse", "CC0 1.0");
let h: DbHandle;
let personId = 0;
let store: ReturnType<typeof createMemoryStore>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  h = await openDb();
  store = createMemoryStore();
  setBlobStore(store);
  vi.mocked(curatorDenial).mockResolvedValue(null);
  vi.mocked(getDb).mockResolvedValue(h.db);
  await h.db.insert(s.households).values({ id: "a", name: "First" });
  const [person] = await h.db.insert(s.people).values({ householdId: "a", name: "Cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] }).returning({ id: s.people.id });
  personId = person!.id;
  vi.mocked(requireMember).mockResolvedValue({ userId: "u", role: "owner", personId } as never);
  vi.mocked(loadCandidates).mockReturnValue({ recipes: { "falafel-bowl": [falafel] }, ingredients: { "tofu-extra-firm": [tofu] } });
  vi.mocked(getData).mockReturnValue({
    recipes: new Map([["falafel-bowl", { slug: "falafel-bowl", name: "Falafel bowl", kind: "recipe" }]]),
    ingredients: new Map([["tofu-extra-firm", { slug: "tofu-extra-firm", name: "Tofu" }]]),
  } as never);
  vi.stubEnv("PHOTO_REMOTE_TEST_DIR", path.resolve("tests/fixtures/photos"));
  vi.stubEnv("DATABASE_ENV", "test");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
  await h.db.insert(s.recipes).values({ slug: "falafel-bowl", name: "Falafel bowl", kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 });
  await h.db.insert(s.ingredients).values({ slug: "tofu-extra-firm", name: "Tofu", aliases: [], state: "ready", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, fibreG: 0, source: "CNF", sourceId: "1", aisle: "produce", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false });
});

const item = { kind: "recipe" as const, slug: "falafel-bowl", key: falafel.key };
const calls: [string, () => Promise<unknown>][] = [
  ["listPendingKeys", () => actions.listPendingKeys({})],
  ["approveLibraryBatch", () => actions.approveLibraryBatch({ items: [item] })],
  ["rejectLibraryBatch", () => actions.rejectLibraryBatch({ items: [item] })],
  ["removeLibraryPhoto", () => actions.removeLibraryPhoto(UID)],
  ["setLibraryCover", () => actions.setLibraryCover(UID)],
  ["undoLibraryRejection", () => actions.undoLibraryRejection(item)],
];

describe("curator gate", () => {
  it.each(calls)("%s returns the denial before touching anything", async (_n, call) => {
    vi.mocked(curatorDenial).mockResolvedValue(denied);
    expect(await call()).toEqual(denied);
    expect(getDb).not.toHaveBeenCalled();
    expect(getData).not.toHaveBeenCalled();
    expect(requireMember).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("rejects malformed input before any work", async () => {
    const bad = [
      actions.listPendingKeys({ kind: "nonsense" } as never), actions.listPendingKeys({ extra: 1 } as never),
      actions.approveLibraryBatch({ items: [] }), actions.approveLibraryBatch({ items: Array.from({ length: 7 }, (_, i) => ({ ...item, key: `commons:${i}` })) }),
      actions.approveLibraryBatch({ items: [{ ...item, image_url: "https://evil.example/x.jpg" }] } as never),
      actions.approveLibraryBatch({ items: [{ ...item, slug: "../x" }] }), actions.approveLibraryBatch({ items: [{ ...item, key: "other:1" }] }),
      actions.rejectLibraryBatch({ items: [] }), actions.rejectLibraryBatch({ items: Array.from({ length: 201 }, (_, i) => ({ ...item, key: `commons:${i}` })) }),
      actions.removeLibraryPhoto("nope"), actions.setLibraryCover("nope"), actions.undoLibraryRejection({ ...item, kind: "x" } as never),
    ];
    for (const r of await Promise.all(bad)) expect(r).toMatchObject({ ok: false });
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("listPendingKeys", () => {
  it("returns keys for the filter, accepting plural kinds", async () => {
    expect(await actions.listPendingKeys({})).toEqual({ ok: true, truncated: false, keys: [{ kind: "recipe", slug: "falafel-bowl", key: falafel.key }, { kind: "ingredient", slug: "tofu-extra-firm", key: tofu.key }] });
    expect(await actions.listPendingKeys({ kind: "ingredients" })).toMatchObject({ keys: [{ slug: "tofu-extra-firm" }] });
    expect(await actions.listPendingKeys({ kind: "recipes", q: "falafel" })).toMatchObject({ keys: [{ slug: "falafel-bowl" }] });
    expect(await actions.listPendingKeys({ kind: "all", pendingOnly: true, onlyWithoutPhoto: true })).toMatchObject({ keys: [{}, {}] });
  });
});

describe("approve, reject and manage", () => {
  it("approves from the server's candidate file through the fixture seam, and invalidates the cache", async () => {
    const r = await actions.approveLibraryBatch({ items: [item, { kind: "ingredient", slug: "tofu-extra-firm", key: tofu.key }] });
    expect(r).toMatchObject({ ok: true, results: [{ status: "approved" }, { status: "approved" }] });
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(2);
    expect(updateTag).toHaveBeenCalledWith("library-photos");
    expect(revalidatePath).toHaveBeenCalledWith("/photos/review");
    expect((await h.db.select().from(s.libraryPhotos))[0]!.createdByPersonId).toBe(personId);
  });
  it("does not invalidate when nothing was approved, and reports the seam guard failing", async () => {
    vi.mocked(updateTag).mockClear();
    expect(await actions.approveLibraryBatch({ items: [item] })).toMatchObject({ ok: true });
    vi.mocked(updateTag).mockClear();
    expect(await actions.approveLibraryBatch({ items: [item] })).toMatchObject({ results: [{ status: "already" }] });
    expect(updateTag).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL", "1");
    await expect(actions.approveLibraryBatch({ items: [item] })).rejects.toThrow(/Vercel/);
  });
  it("rejects only listed candidates, then undoes, covers and removes", async () => {
    expect(await actions.rejectLibraryBatch({ items: [item, { ...item, key: "commons:unlisted" }] })).toEqual({ ok: true, rejected: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/photos/review");
    expect(updateTag).not.toHaveBeenCalled();
    expect(await actions.undoLibraryRejection(item)).toEqual({ ok: true });
    expect(await actions.undoLibraryRejection(item)).toMatchObject({ ok: false });

    const jpeg = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const uids: string[] = [];
    for (const k of ["commons:a", "commons:b"]) {
      const r = await approveLibraryCandidate(h.db, store, { candidateKey: k, subjectKind: "recipe", subjectSlug: "falafel-bowl", origin: "commons", bytes: jpeg, credit: { title: "t", author: "a", licence: "CC0", sourceUrl: "https://x.example/y" }, licenceCheckedAt: null, personId: null });
      uids.push((r as { uid: string }).uid);
    }
    expect(await actions.setLibraryCover(uids[1]!)).toEqual({ ok: true });
    expect(updateTag).toHaveBeenCalledWith("library-photos");
    expect(await actions.setLibraryCover(UID)).toMatchObject({ ok: false });
    expect(await actions.removeLibraryPhoto(uids[1]!)).toEqual({ ok: true });
    expect(await actions.removeLibraryPhoto(uids[1]!)).toMatchObject({ ok: false });
    expect(await store.list()).toHaveLength(2);
  });
});
