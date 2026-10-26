import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../lib/blob/memory";
import type { BlobStore } from "../lib/blob/types";
import * as s from "../lib/db/schema";
import { approveLibraryCandidate } from "../lib/human/library-photos";
import type { Candidate, CandidateFile } from "../lib/photos/candidates";
import {
  approveBatch, APPROVE_BATCH_MAX, listPendingKeys, pendingLibraryReview, RATE_PER_DAY, RATE_PER_HOUR, recentApprovals, type ItemRef, type ItemResult,
} from "../lib/server/library-review";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let store: ReturnType<typeof createMemoryStore>;
let jpeg: Buffer;

const UA = "ProteinKitchen/test (+https://kitchen.example.test; library photo review)";
const cand = (key: string, over: Partial<Candidate> = {}): Candidate => ({
  key, provider: key.startsWith("commons:") ? "commons" : "openverse", title: `Photo ${key}`, author: "Someone", licence: key.startsWith("commons:") ? "CC BY-SA 4.0" : "CC0 1.0",
  licence_url: null, source_url: "https://commons.wikimedia.org/wiki/File:X.jpg", image_url: `https://upload.wikimedia.org/img/${encodeURIComponent(key.replace(/[^a-z0-9]/gi, "_"))}.jpg`, width: 100, height: 80, ...over,
});
const ref = (kind: "recipe" | "ingredient", slug: string, key: string): ItemRef => ({ kind, slug, key });

async function addRecipe(slug: string) {
  await h.db.insert(s.recipes).values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 }).onConflictDoNothing();
}
async function addIngredient(slug: string) {
  await h.db.insert(s.ingredients).values({
    slug, name: slug, aliases: [], state: "ready", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, fibreG: 0, source: "CNF", sourceId: "1", aisle: "produce",
    whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  }).onConflictDoNothing();
}

interface Fake {
  fetch: typeof fetch;
  calls: string[];
  commonsCalls: string[][];
  inFlight: { now: number; max: number };
  images: Map<string, () => Response | Promise<Response>>;
  licences: Map<string, string>;
  headers: string[];
}
/** A provider double: nothing here touches the network. */
function fake(opts: { delayMs?: number } = {}): Fake {
  const f: Fake = { fetch: undefined as never, calls: [], commonsCalls: [], inFlight: { now: 0, max: 0 }, images: new Map(), licences: new Map(), headers: [] };
  const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
  f.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    f.calls.push(url.toString());
    f.headers.push(new Headers(init?.headers).get("user-agent") ?? "");
    if (url.hostname === "commons.wikimedia.org") {
      const titles = (url.searchParams.get("titles") ?? "").split("|");
      f.commonsCalls.push(titles);
      const pages: Record<string, unknown> = {};
      titles.forEach((title, i) => {
        const licence = f.licences.get(`commons:${title}`);
        pages[String(i + 1)] = licence === undefined ? { title, missing: "" } : { title, imageinfo: [{ extmetadata: { LicenseShortName: { value: licence } } }] };
      });
      return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
    }
    if (url.hostname === "api.openverse.org" && /^\/v1\/images\/[^/]+\/$/.test(url.pathname)) {
      const licence = f.licences.get(`openverse:${decodeURIComponent(url.pathname.split("/")[3]!)}`);
      return licence === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ license: licence }), { status: 200 });
    }
    f.inFlight.now++;
    f.inFlight.max = Math.max(f.inFlight.max, f.inFlight.now);
    try {
      if (opts.delayMs) await wait(opts.delayMs, init?.signal);
      const custom = f.images.get(url.toString());
      if (custom) return await custom();
      return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } });
    } finally { f.inFlight.now--; }
  }) as typeof fetch;
  return f;
}
/** Registers the licence a provider reports for each candidate (as listed). */
const listAll = (f: Fake, ...cs: Candidate[]) => cs.forEach((c) => f.licences.set(c.key, c.provider === "commons" ? c.licence : "cc0"));
const file = (recipes: Record<string, Candidate[]>, ingredients: Record<string, Candidate[]> = {}): CandidateFile => ({ recipes, ingredients });
const statuses = (results: ItemResult[]) => results.map((r) => r.status);
const ok = (r: Awaited<ReturnType<typeof approveBatch>>) => { if (!r.ok) throw new Error(r.error); return r.results; };

beforeEach(async () => {
  h = await openDb();
  store = createMemoryStore();
  jpeg = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#c87828" } }).jpeg().toBuffer();
});
afterEach(() => vi.restoreAllMocks());

describe("approveBatch happy path", () => {
  it("approves from the server's own list, checks Commons licences in one call and Openverse one call per id", async () => {
    await addRecipe("falafel-bowl"); await addRecipe("dal-tadka"); await addIngredient("tofu-extra-firm");
    const a = cand("commons:File:Falafel A.jpg"), b = cand("commons:File:Dal B.jpg"), c = cand("openverse:abc-123", { image_url: "https://upload.wikimedia.org/img/tofu.jpg" });
    const f = fake(); listAll(f, a, b, c);
    const candidates = file({ "falafel-bowl": [a], "dal-tadka": [b] }, { "tofu-extra-firm": [c] });
    const results = ok(await approveBatch(h.db, store, candidates, [ref("recipe", "falafel-bowl", a.key), ref("recipe", "dal-tadka", b.key), ref("ingredient", "tofu-extra-firm", c.key)], { fetchImpl: f.fetch, userAgent: UA }));
    expect(statuses(results)).toEqual(["approved", "approved", "approved"]);
    expect(f.commonsCalls).toEqual([["File:Falafel A.jpg", "File:Dal B.jpg"]]);
    expect(f.calls.filter((u) => u.includes("api.openverse.org"))).toEqual(["https://api.openverse.org/v1/images/abc-123/"]);
    expect(f.calls.filter((u) => u.includes("/img/"))).toHaveLength(3);
    expect(new Set(f.headers)).toEqual(new Set([UA]));
    const rows = await h.db.select().from(s.libraryPhotos);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.candidateKey === c.key)).toMatchObject({ origin: "openverse", licence: "CC0 1.0", width: 200, isCover: true });
    expect(rows[0]!.licenceCheckedAt).not.toBeNull();
    expect(await store.list()).toHaveLength(6);
    expect((await sharp((await store.get(`library/${rows[0]!.uid}/master.webp`))!.bytes).metadata()).format).toBe("webp");
  });

  it("is idempotent: a second run reports already and makes no request", async () => {
    await addRecipe("falafel-bowl");
    const a = cand("commons:File:A.jpg"); const f = fake(); listAll(f, a);
    const items = [ref("recipe", "falafel-bowl", a.key)];
    expect(statuses(ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a] }), items, { fetchImpl: f.fetch })))).toEqual(["approved"]);
    const before = f.calls.length;
    expect(statuses(ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a] }), items, { fetchImpl: f.fetch })))).toEqual(["already"]);
    expect(f.calls.length).toBe(before);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(1);
  });

  it("reports already when a concurrent writer wins between the local check and the write", async () => {
    await addRecipe("falafel-bowl");
    const a = cand("commons:File:A.jpg"); const f = fake(); listAll(f, a);
    f.images.set(a.image_url, async () => {
      await approveLibraryCandidate(h.db, store, { candidateKey: a.key, subjectKind: "recipe", subjectSlug: "falafel-bowl", origin: "commons", bytes: jpeg, credit: { title: "t", author: "a", licence: "CC BY-SA 4.0", sourceUrl: "https://x.example/y" }, licenceCheckedAt: null, personId: null });
      return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    expect(statuses(ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a] }), [ref("recipe", "falafel-bowl", a.key)], { fetchImpl: f.fetch })))).toEqual(["already"]);
    expect(await store.list()).toHaveLength(2);
  });

  it("dedupes repeated items and handles an empty or oversized batch", async () => {
    await addRecipe("falafel-bowl");
    const a = cand("commons:File:A.jpg"); const f = fake(); listAll(f, a);
    const same = ref("recipe", "falafel-bowl", a.key);
    expect(ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a] }), [same, { ...same }, same], { fetchImpl: f.fetch }))).toHaveLength(1);
    expect(f.calls.filter((u) => u.includes("/img/"))).toHaveLength(1);
    expect(ok(await approveBatch(h.db, store, file({}), [], { fetchImpl: f.fetch }))).toEqual([]);
    const many = Array.from({ length: APPROVE_BATCH_MAX + 1 }, (_, i) => ref("recipe", "falafel-bowl", `commons:File:${i}.jpg`));
    expect(await approveBatch(h.db, store, file({}), many, { fetchImpl: f.fetch })).toMatchObject({ ok: false });
  });
});

describe("approveBatch refusals", () => {
  it("fails an unlisted candidate, a missing recipe and a missing ingredient without any request", async () => {
    const a = cand("commons:File:A.jpg"); const f = fake();
    const results = ok(await approveBatch(h.db, store, file({ ghost: [a] }, { nothing: [a] }), [ref("recipe", "ghost", a.key), ref("ingredient", "nothing", a.key), ref("recipe", "ghost", "commons:File:other.jpg")], { fetchImpl: f.fetch }));
    expect(results.map((r) => [r.status, r.error])).toEqual([["failed", "Recipe not found."], ["failed", "Ingredient not found."], ["failed", "That photo is no longer in the candidate list."]]);
    expect(f.calls).toEqual([]);
  });

  it("refuses a licence that changed or disappeared between the list and the approval", async () => {
    await addRecipe("r1"); await addRecipe("r2"); await addRecipe("r3"); await addIngredient("i1"); await addIngredient("i2");
    const c1 = cand("commons:File:Changed.jpg"), c2 = cand("commons:File:NC.jpg"), c3 = cand("commons:File:Gone.jpg"), o1 = cand("openverse:nc"), o2 = cand("openverse:gone");
    const f = fake();
    f.licences.set(c1.key, "CC BY 4.0"); f.licences.set(c2.key, "CC BY-NC 4.0"); f.licences.set(o1.key, "by-nc");
    const results = ok(await approveBatch(h.db, store, file({ r1: [c1], r2: [c2], r3: [c3] }, { i1: [o1], i2: [o2] }),
      [ref("recipe", "r1", c1.key), ref("recipe", "r2", c2.key), ref("recipe", "r3", c3.key), ref("ingredient", "i1", o1.key), ref("ingredient", "i2", o2.key)], { fetchImpl: f.fetch }));
    expect(statuses(results)).toEqual(Array(5).fill("failed"));
    expect(results[0]!.error).toMatch(/changed from CC BY-SA 4.0 to CC BY 4.0/);
    expect(results[1]!.error).toMatch(/cannot be used/);
    expect(results[2]!.error).toMatch(/cannot be used/);
    expect(results[3]!.error).toMatch(/cannot be used/);
    expect(results[4]!.error).toMatch(/Try again/);
    expect(f.calls.some((u) => u.includes("/img/"))).toBe(false);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(0);
  });

  it("fails every Commons item when the licence call cannot be read, but still uses one call", async () => {
    await addRecipe("r1"); await addRecipe("r2");
    const c1 = cand("commons:File:One.jpg"), c2 = cand("commons:File:Two.jpg");
    for (const bad of [(async () => new Response("no", { status: 500 })) as typeof fetch, (async () => { throw new Error("down"); }) as typeof fetch, (async () => new Response("not json", { status: 200 })) as typeof fetch]) {
      const spy = vi.fn(bad);
      const results = ok(await approveBatch(h.db, store, file({ r1: [c1], r2: [c2] }), [ref("recipe", "r1", c1.key), ref("recipe", "r2", c2.key)], { fetchImpl: spy }));
      expect(results.map((r) => [r.status, r.error])).toEqual([["failed", expect.stringContaining("Try again")], ["failed", expect.stringContaining("Try again")]]);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("returns subject-full without downloading when the subject already has three photos", async () => {
    await addRecipe("falafel-bowl");
    for (let i = 0; i < 3; i++) {
      await approveLibraryCandidate(h.db, store, { candidateKey: `commons:File:${i}.jpg`, subjectKind: "recipe", subjectSlug: "falafel-bowl", origin: "commons", bytes: jpeg, credit: { title: "t", author: "a", licence: "CC0", sourceUrl: "https://x.example/y" }, licenceCheckedAt: null, personId: null });
    }
    const a = cand("commons:File:Fourth.jpg"); const f = fake(); listAll(f, a);
    const results = ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a] }), [ref("recipe", "falafel-bowl", a.key)], { fetchImpl: f.fetch }));
    expect(statuses(results)).toEqual(["subject-full"]);
    expect(f.calls).toEqual([]);
  });

  it("lets only the photos that fit in: two new photos for a subject with two give one approval and one subject-full", async () => {
    await addRecipe("falafel-bowl");
    for (let i = 0; i < 2; i++) {
      await approveLibraryCandidate(h.db, store, { candidateKey: `commons:File:${i}.jpg`, subjectKind: "recipe", subjectSlug: "falafel-bowl", origin: "commons", bytes: jpeg, credit: { title: "t", author: "a", licence: "CC0", sourceUrl: "https://x.example/y" }, licenceCheckedAt: null, personId: null });
    }
    const a = cand("commons:File:New1.jpg"), b = cand("commons:File:New2.jpg"); const f = fake({ delayMs: 5 }); listAll(f, a, b);
    const results = ok(await approveBatch(h.db, store, file({ "falafel-bowl": [a, b] }), [ref("recipe", "falafel-bowl", a.key), ref("recipe", "falafel-bowl", b.key)], { fetchImpl: f.fetch }));
    expect(statuses(results).sort()).toEqual(["approved", "subject-full"]);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(3);
    expect(await store.list()).toHaveLength(6);
  });
});

describe("approveBatch download problems", () => {
  async function run(make: () => Response | Promise<Response>, extra: Partial<Candidate> = {}) {
    await addRecipe("r1");
    const c = cand("commons:File:One.jpg", extra); const f = fake(); listAll(f, c);
    f.images.set(c.image_url, make);
    const results = ok(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch }));
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(0);
    expect(await store.list()).toEqual([]);
    return results[0]!;
  }

  it("rejects a redirect to a host that is not allowed", async () => {
    const r = await run(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } }));
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("not on a site") });
  });
  it("rejects an image that grows past 8 MB while streaming, and one that declares it", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const streaming = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); } }), { status: 200, headers: { "content-type": "image/jpeg" } });
    expect(await run(streaming)).toMatchObject({ status: "failed", error: expect.stringContaining("8 MB") });
  });
  it("rejects a declared oversize image", async () => {
    expect(await run(() => new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) } }))).toMatchObject({ status: "failed", error: expect.stringContaining("8 MB") });
  });
  it("rejects a response that is not an image", async () => {
    expect(await run(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))).toMatchObject({ status: "failed", error: "The image site did not send an image." });
  });
  it("rejects a 404, bytes that are not a picture, and a download cut short", async () => {
    expect(await run(() => new Response("no", { status: 404 }))).toMatchObject({ status: "failed", error: expect.stringContaining("404") });
    expect(await run(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }))).toMatchObject({ status: "failed", error: expect.stringContaining("not an image") });
  });
  it("reports an unexpected error as a plain message and logs only a code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await addRecipe("r1");
    const c = cand("commons:File:One.jpg"); const f = fake(); listAll(f, c);
    const broken: BlobStore = { ...store, put: async () => { throw new TypeError("secret detail /etc/passwd"); } };
    const [r] = ok(await approveBatch(h.db, broken, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch }));
    expect(r).toMatchObject({ status: "failed", error: "That photo could not be saved. Try again." });
    expect(log).toHaveBeenCalledWith("Library photo approval failed unexpectedly.", "TypeError");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
  it("labels an unknown error that is not an Error object", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await addRecipe("r1");
    const c = cand("commons:File:One.jpg"); const f = fake(); listAll(f, c);
    const broken: BlobStore = { ...store, put: async () => { throw "plain string"; } };
    const [r] = ok(await approveBatch(h.db, broken, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch }));
    expect(r!.status).toBe("failed");
    expect(console.error).toHaveBeenCalledWith("Library photo approval failed unexpectedly.", "UNKNOWN");
  });
  it("reports a missing subject found only at write time", async () => {
    await addRecipe("r1");
    const c = cand("commons:File:One.jpg"); const f = fake(); listAll(f, c);
    f.images.set(c.image_url, async () => { await h.db.delete(s.recipes).where(eq(s.recipes.slug, "r1")); return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }); });
    expect(statuses(ok(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch })))).toEqual(["failed"]);
    await addIngredient("i1");
    const o = cand("openverse:x1"); listAll(f, o);
    f.images.set(o.image_url, async () => { await h.db.delete(s.ingredients).where(eq(s.ingredients.slug, "i1")); return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }); });
    const [r] = ok(await approveBatch(h.db, store, file({}, { i1: [o] }), [ref("ingredient", "i1", o.key)], { fetchImpl: f.fetch }));
    expect(r).toMatchObject({ status: "failed", error: "Ingredient not found." });
  });
});

describe("approveBatch concurrency and budgets", () => {
  async function six() {
    const refs: ItemRef[] = []; const recipes: Record<string, Candidate[]> = {}; const f = fake({ delayMs: 30 });
    for (let i = 0; i < 6; i++) {
      await addRecipe(`r${i}`);
      const c = cand(`commons:File:${i}.jpg`); listAll(f, c); recipes[`r${i}`] = [c]; refs.push(ref("recipe", `r${i}`, c.key));
    }
    return { refs, recipes, f };
  }

  it("never has more than three downloads in flight", async () => {
    const { refs, recipes, f } = await six();
    const results = ok(await approveBatch(h.db, store, file(recipes), refs, { fetchImpl: f.fetch }));
    expect(statuses(results)).toEqual(Array(6).fill("approved"));
    expect(f.inFlight.max).toBe(3);
  });

  it("answers an item that passes its own deadline with not-attempted and keeps the others", async () => {
    const { refs, recipes, f } = await six();
    const hang = recipes.r1![0]!;
    f.images.set(hang.image_url, () => new Promise<Response>(() => {}));
    // The hanging fetch ignores the signal, so the deadline must still release the item.
    const results = ok(await approveBatch(h.db, store, file(recipes), refs, { fetchImpl: ((url: string, init?: RequestInit) => url.includes("commons_File_1_jpg") ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) : f.fetch(url, init)) as unknown as typeof fetch, budget: { itemMs: 80, requestMs: 5_000 } }));
    expect(results[1]).toMatchObject({ status: "not-attempted" });
    expect(statuses(results.filter((_, i) => i !== 1))).toEqual(Array(5).fill("approved"));
  });

  it("starts no new item after the cutoff and returns the rest as not-attempted", async () => {
    const { refs, recipes, f } = await six();
    let t = 0;
    const slow = ((url: string, init?: RequestInit) => { if (url.includes("/img/")) t += 61_000; return f.fetch(url, init); }) as typeof fetch;
    const results = ok(await approveBatch(h.db, store, file(recipes), refs, { fetchImpl: slow, now: () => t, budget: { concurrency: 1 } }));
    expect(statuses(results)).toEqual(["approved", "not-attempted", "not-attempted", "not-attempted", "not-attempted", "not-attempted"]);
    expect(results[1]!.error).toMatch(/Try it again/);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(1);
  });

  it("stops everything at the batch budget", async () => {
    const { refs, recipes, f } = await six();
    const slow = ((url: string, init?: RequestInit) => (url.includes("/img/") ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) : f.fetch(url, init))) as unknown as typeof fetch;
    const results = ok(await approveBatch(h.db, store, file(recipes), refs, { fetchImpl: slow, budget: { batchMs: 60, itemMs: 5_000, requestMs: 5_000 } }));
    expect(statuses(results)).toEqual(Array(6).fill("not-attempted"));
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(0);
  });

  it("does not write when the deadline passes right after the download", async () => {
    await addRecipe("r1");
    const c = cand("commons:File:One.jpg"); const f = fake(); listAll(f, c);
    f.images.set(c.image_url, async () => { await new Promise((r) => setTimeout(r, 60)); return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }); });
    const slowButIgnoringSignal = f.fetch;
    const results = ok(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: slowButIgnoringSignal, budget: { itemMs: 20 } }));
    expect(statuses(results)).toEqual(["not-attempted"]);
    expect(await h.db.select().from(s.libraryPhotos)).toHaveLength(0);
  });

  it("does not write when the deadline passes during the Openverse licence check", async () => {
    await addIngredient("i1");
    const o = cand("openverse:slow"); const f = fake(); listAll(f, o);
    const slow = (async (url: string, init?: RequestInit) => { if (url.includes("openverse.org/v1")) await new Promise((r) => setTimeout(r, 60)); return f.fetch(url, init); }) as typeof fetch;
    expect(statuses(ok(await approveBatch(h.db, store, file({}, { i1: [o] }), [ref("ingredient", "i1", o.key)], { fetchImpl: slow, budget: { itemMs: 20 } })))).toEqual(["not-attempted"]);
  });
});

describe("rate cap", () => {
  async function seedApprovals(count: number, at: string, personId: number | null) {
    for (let start = 0; start < count; start += 200) {
      await h.db.insert(s.libraryPhotoDecisions).values(Array.from({ length: Math.min(200, count - start) }, (_, i) => ({
        uid: `d-${personId}-${at}-${start + i}`, candidateKey: `commons:File:${start + i}.jpg`, subjectKind: "recipe", subjectSlug: "old", decision: "approved",
        createdAt: at, updatedAt: at, createdByPersonId: personId,
      })));
    }
  }
  const setup = async () => { await addRecipe("r1"); const c = cand("commons:File:New.jpg"); const f = fake(); listAll(f, c); return { c, f }; };

  it("refuses before any request when the person is over 300 an hour", async () => {
    const { c, f } = await setup();
    await seedApprovals(RATE_PER_HOUR, new Date().toISOString(), null);
    const r = await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("more approvals") });
    expect(f.calls).toEqual([]);
  });
  it("refuses when this batch would cross the line, and allows exactly up to it", async () => {
    const { c, f } = await setup();
    await seedApprovals(RATE_PER_HOUR - 1, new Date().toISOString(), null);
    expect(statuses(ok(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch })))).toEqual(["approved"]);
    expect(await recentApprovals(h.db, null, Date.now())).toEqual({ hour: RATE_PER_HOUR, day: RATE_PER_HOUR });
  });
  it("refuses at 1000 a day even when the last hour is quiet, and counts per person", async () => {
    const { c, f } = await setup();
    await h.db.insert(s.households).values({ id: "a", name: "First" });
    const [person] = await h.db.insert(s.people).values({ householdId: "a", name: "Cook", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] }).returning({ id: s.people.id });
    await seedApprovals(RATE_PER_DAY, new Date(Date.now() - 2 * 3_600_000).toISOString(), person!.id);
    expect(await recentApprovals(h.db, person!.id, Date.now())).toEqual({ hour: 0, day: RATE_PER_DAY });
    expect(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch, personId: person!.id })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    expect(statuses(ok(await approveBatch(h.db, store, file({ r1: [c] }), [ref("recipe", "r1", c.key)], { fetchImpl: f.fetch })))).toEqual(["approved"]);
  });
  it("ignores approvals older than a day and rejections", async () => {
    await seedApprovals(RATE_PER_DAY, new Date(Date.now() - 25 * 3_600_000).toISOString(), null);
    await h.db.insert(s.libraryPhotoDecisions).values({ uid: "rej", candidateKey: "commons:File:r.jpg", subjectKind: "recipe", subjectSlug: "old", decision: "rejected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect(await recentApprovals(h.db, null, Date.now())).toEqual({ hour: 0, day: 0 });
  });
});

describe("pending lists", () => {
  const names = { recipes: new Map([["falafel-bowl", "Baked falafel bowl"], ["dal-tadka", "Dal tadka"]]), ingredients: new Map([["tofu-extra-firm", "Tofu"], ["soy-milk", "Soy milk"]]) };
  const a = cand("commons:File:A.jpg"), b = cand("commons:File:B.jpg"), c = cand("openverse:c"), d = cand("openverse:d");
  const candidates = () => file({ "falafel-bowl": [a, b], "dal-tadka": [a] }, { "tofu-extra-firm": [c], "soy-milk": [d], "not-in-library": [d] });

  it("filters by kind, search, pending-only and without-a-photo, and puts subjects without a photo first", async () => {
    await addRecipe("falafel-bowl"); await addRecipe("dal-tadka");
    await approveLibraryCandidate(h.db, store, { candidateKey: b.key, subjectKind: "recipe", subjectSlug: "falafel-bowl", origin: "commons", bytes: jpeg, credit: { title: "t", author: "a", licence: "CC0", sourceUrl: "https://x.example/y" }, licenceCheckedAt: null, personId: null });
    await h.db.insert(s.libraryPhotoDecisions).values({ uid: "rej", candidateKey: c.key, subjectKind: "ingredient", subjectSlug: "tofu-extra-firm", decision: "rejected", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    const slugs = async (filter = {}) => (await pendingLibraryReview(h.db, candidates(), names, filter)).map((i) => `${i.kind}:${i.slug}`);
    expect(await slugs()).toEqual(["recipe:dal-tadka", "ingredient:soy-milk", "recipe:falafel-bowl"]);
    expect(await slugs({ kind: "ingredient" })).toEqual(["ingredient:soy-milk"]);
    expect(await slugs({ kind: "recipe", q: "FALAFEL" })).toEqual(["recipe:falafel-bowl"]);
    expect(await slugs({ q: "dal-tadka" })).toEqual(["recipe:dal-tadka"]);
    expect(await slugs({ onlyWithoutPhoto: true })).toEqual(["recipe:dal-tadka", "ingredient:soy-milk"]);
    expect(await slugs({ pendingOnly: false })).toEqual(["recipe:dal-tadka", "ingredient:soy-milk", "ingredient:tofu-extra-firm", "recipe:falafel-bowl"]);
    const [falafel] = await pendingLibraryReview(h.db, candidates(), names, { q: "falafel" });
    expect(falafel!.candidates.map((x) => x.key)).toEqual([a.key]);
  });

  it("lists keys only (never URLs or credits) and honours the limit", async () => {
    await addRecipe("falafel-bowl"); await addRecipe("dal-tadka");
    const keys = await listPendingKeys(h.db, candidates(), names);
    expect(keys).toEqual([
      ref("recipe", "dal-tadka", a.key), ref("ingredient", "soy-milk", d.key), ref("ingredient", "tofu-extra-firm", c.key),
      ref("recipe", "falafel-bowl", a.key), ref("recipe", "falafel-bowl", b.key),
    ].sort((x, y) => keys.findIndex((k) => k.slug === x.slug && k.key === x.key) - keys.findIndex((k) => k.slug === y.slug && k.key === y.key)));
    expect(keys).toHaveLength(5);
    for (const k of keys) expect(Object.keys(k).sort()).toEqual(["key", "kind", "slug"]);
    expect(await listPendingKeys(h.db, candidates(), names, {}, 2)).toHaveLength(2);
    expect(await listPendingKeys(h.db, candidates(), names, { kind: "recipe" })).toHaveLength(3);
  });
});
