import { describe, expect, it } from "vitest";
import { LIBRARY_PHOTO_CAP } from "../lib/human/library-photos";
import {
  APPROVE_CHUNK, CANCELLED, capWarnings, chunk, clickTile, countSelection, DEFAULT_PARAMS, describeSelection, firstOfEach, mergeResults, NETWORK_ERROR, NO_ANSWER,
  PAGE_SIZE, pageKeys, pageWindow, parseRefKey, parseReviewParams, PER_SUBJECT_CAP, progressText, rangeKeys, refKey, rejectOutcome, REJECT_CHUNK, retryKeys, reviewHref,
  runChunks, SELECT_ALL_LIMIT, selectionRefs, setKeys, subjectKey, tallyResults, toggleKey, type ItemRef, type RunResult, type SendOutcome,
} from "../lib/photos/review-selection";
import { APPROVE_BATCH_MAX, PENDING_KEYS_MAX, REJECT_BATCH_MAX } from "../lib/server/library-review";

const ref = (kind: "recipe" | "ingredient", slug: string, n: number): ItemRef => ({ kind, slug, key: `commons:File:${slug} ${n}.jpg` });
const ok = (r: ItemRef, status: RunResult["status"] = "approved"): RunResult => ({ ...r, status });

describe("constants match the server", () => {
  it("keeps chunk sizes, cap and list limit equal to the server's", () => {
    expect(APPROVE_CHUNK).toBe(APPROVE_BATCH_MAX);
    expect(REJECT_CHUNK).toBe(REJECT_BATCH_MAX);
    expect(PER_SUBJECT_CAP).toBe(LIBRARY_PHOTO_CAP);
    expect(SELECT_ALL_LIMIT).toBe(PENDING_KEYS_MAX);
    expect(PAGE_SIZE).toBe(30);
  });
});

describe("selection keys", () => {
  it("round-trips a key whose candidate key contains colons and spaces", () => {
    const r = ref("ingredient", "tomato", 1);
    expect(refKey(r)).toBe("ingredient:tomato:commons:File:tomato 1.jpg");
    expect(parseRefKey(refKey(r))).toEqual(r);
    expect(subjectKey(r)).toBe("ingredient:tomato");
  });
  it("rejects malformed keys", () => {
    for (const bad of ["", "recipe", "recipe:slug", "fruit:slug:commons:x", ":slug:commons:x", "recipe::commons:x", "recipe:slug:"]) expect(parseRefKey(bad), bad).toBeNull();
  });
  it("toggles and bulk sets without changing the input", () => {
    const start = new Set(["a"]);
    expect([...toggleKey(start, "b")]).toEqual(["a", "b"]);
    expect([...toggleKey(start, "a")]).toEqual([]);
    expect([...setKeys(start, ["b", "c"], true)]).toEqual(["a", "b", "c"]);
    expect([...setKeys(start, ["a", "z"], false)]).toEqual([]);
    expect([...start]).toEqual(["a"]);
  });
});

describe("range select", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("returns both ends and everything between, in either direction", () => {
    expect(rangeKeys(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(order, "c", "c")).toEqual(["c"]);
  });
  it("handles an anchor that left the page and a target that is not on it", () => {
    expect(rangeKeys(order, "gone", "c")).toEqual(["c"]);
    expect(rangeKeys(order, "a", "gone")).toEqual([]);
  });
  it("plain click toggles and moves the anchor", () => {
    const first = clickTile(new Set(), order, null, "b", false);
    expect([...first.selection]).toEqual(["b"]);
    expect(first.anchor).toBe("b");
    const second = clickTile(first.selection, order, first.anchor, "b", false);
    expect([...second.selection]).toEqual([]);
  });
  it("shift click applies the anchor's state to the range", () => {
    const a = clickTile(new Set(), order, null, "b", false);
    const range = clickTile(a.selection, order, a.anchor, "d", true);
    expect([...range.selection].sort()).toEqual(["b", "c", "d"]);
    expect(range.anchor).toBe("d");
    // The anchor is now d and selected; shift back to b over a selected run keeps it selected.
    const again = clickTile(range.selection, order, range.anchor, "a", true);
    expect([...again.selection].sort()).toEqual(["a", "b", "c", "d"]);
    // An anchor that was deselected clears the range.
    const off = clickTile(again.selection, order, "a", "a", false); // deselect a, anchor a
    const cleared = clickTile(off.selection, order, off.anchor, "c", true);
    expect([...cleared.selection]).toEqual(["d"]);
  });
  it("shift click without a usable anchor falls back to a toggle", () => {
    expect([...clickTile(new Set(), order, null, "c", true).selection]).toEqual(["c"]);
    expect([...clickTile(new Set(), order, "gone", "c", true).selection]).toEqual(["c"]);
    expect([...clickTile(new Set(["c"]), order, "c", "c", true).selection]).toEqual([]);
  });
});

describe("page helpers", () => {
  const items = [
    { kind: "recipe" as const, slug: "falafel", candidates: [{ key: "commons:a" }, { key: "commons:b" }] },
    { kind: "ingredient" as const, slug: "tofu", candidates: [{ key: "openverse:c" }] },
    { kind: "ingredient" as const, slug: "empty", candidates: [] },
  ];
  it("lists every candidate key in page order and the first of each subject", () => {
    expect(pageKeys(items)).toEqual(["recipe:falafel:commons:a", "recipe:falafel:commons:b", "ingredient:tofu:openverse:c"]);
    expect(firstOfEach(items)).toEqual(["recipe:falafel:commons:a", "ingredient:tofu:openverse:c"]);
  });
  it("counts and describes a selection by kind", () => {
    const sel = new Set([...pageKeys(items), "junk"]);
    expect(countSelection(sel)).toEqual({ total: 3, recipes: 2, ingredients: 1, subjects: 2 });
    expect(describeSelection(countSelection(sel))).toBe("3 selected (2 recipes, 1 ingredient)");
    expect(describeSelection(countSelection(new Set(["recipe:x:commons:y"])))).toBe("1 selected (1 recipe)");
    expect(describeSelection(countSelection(new Set(["ingredient:x:commons:y", "ingredient:x:commons:z"])))).toBe("2 selected (2 ingredients)");
    expect(describeSelection(countSelection(new Set()))).toBe("0 selected");
    expect(selectionRefs(sel).map(refKey)).toEqual(pageKeys(items));
  });
  it("describes 23 selected with both kinds", () => {
    const sel = new Set<string>();
    for (let n = 0; n < 15; n++) sel.add(refKey(ref("recipe", `r${n}`, 1)));
    for (let n = 0; n < 8; n++) sel.add(refKey(ref("ingredient", `i${n}`, 1)));
    expect(describeSelection(countSelection(sel))).toBe("23 selected (15 recipes, 8 ingredients)");
  });
});

describe("per-subject cap warnings", () => {
  const sel = new Set([1, 2, 3, 4].map((n) => refKey(ref("recipe", "falafel", n))).concat([1, 2].map((n) => refKey(ref("ingredient", "tofu", n))), [refKey(ref("ingredient", "rice", 1))]));
  it("warns only where the selection exceeds the room left", () => {
    const warnings = capWarnings(sel, new Map([["recipe:falafel", 0], ["ingredient:tofu", 2]]), new Map([["recipe:falafel", "Falafel bowl"]]));
    expect(warnings.map((w) => [w.subject, w.selected, w.free])).toEqual([["recipe:falafel", 4, 3], ["ingredient:tofu", 2, 1]]);
    expect(warnings[0]!.message).toBe("Falafel bowl has room for 3 more photos, and 4 are selected. The extra ones will be reported as full.");
    expect(warnings[1]!.message).toContain("tofu has room for 1 more photo, and 2 are selected");
  });
  it("says a full subject cannot take more, and treats unseen subjects as empty", () => {
    const warnings = capWarnings(new Set([refKey(ref("recipe", "a", 1))]), new Map([["recipe:a", 3]]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("a already has the most photos it can keep, and 1 are selected. The extra ones will be reported as full.");
    expect(capWarnings(sel, new Map())).toHaveLength(1);
    expect(capWarnings(new Set(), new Map())).toEqual([]);
    expect(capWarnings(new Set([refKey(ref("recipe", "a", 1)), refKey(ref("recipe", "a", 2))]), new Map([["recipe:a", 3]]), new Map(), 5)).toEqual([]);
  });
});

describe("chunking, merging and retry", () => {
  it("splits into groups of at most the size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 6)).toEqual([]);
    expect(chunk(Array.from({ length: 23 }, (_, n) => n), APPROVE_CHUNK).map((c) => c.length)).toEqual([6, 6, 6, 5]);
  });
  it("merges newer results over older ones without mutating", () => {
    const a = ref("recipe", "a", 1);
    const b = ref("recipe", "b", 1);
    const before = new Map([[refKey(a), { ...a, status: "failed" as const, error: "x" }], [refKey(b), ok(b)]]);
    const after = mergeResults(before, [ok(a)]);
    expect(after.get(refKey(a))!.status).toBe("approved");
    expect(before.get(refKey(a))!.status).toBe("failed");
    expect(after.size).toBe(2);
  });
  it("selects only failed and untried items again, and tallies every status", () => {
    const rs: RunResult[] = (["approved", "already", "subject-full", "not-attempted", "failed", "rejected", "failed"] as const).map((status, n) => ({ ...ref("recipe", `s${n}`, 1), status }));
    expect([...retryKeys(rs)]).toEqual([refKey(rs[3]!), refKey(rs[4]!), refKey(rs[6]!)]);
    expect(tallyResults(rs)).toEqual({ approved: 1, already: 1, "subject-full": 1, "not-attempted": 1, failed: 2, rejected: 1 });
  });
});

describe("runChunks", () => {
  const refs = Array.from({ length: 14 }, (_, n) => ref(n % 2 ? "recipe" : "ingredient", `s${n}`, 1));
  const approveAll = async (part: ItemRef[]): Promise<SendOutcome> => ({ ok: true, results: part.map((r) => ok(r)) });

  it("sends one chunk at a time and reports progress after each", async () => {
    const sizes: number[] = [];
    let inFlight = 0;
    let max = 0;
    const progress: string[] = [];
    const out = await runChunks({
      refs, size: 6, cancelled: () => false,
      send: async (part) => { inFlight++; max = Math.max(max, inFlight); sizes.push(part.length); await Promise.resolve(); inFlight--; return approveAll(part); },
      onProgress: (p) => progress.push(progressText("approve", p, false)),
    });
    expect(sizes).toEqual([6, 6, 2]);
    expect(max).toBe(1);
    expect(progress).toEqual(["Approving 0 of 14", "Approving 6 of 14", "Approving 12 of 14", "Approving 14 of 14"]);
    expect(out.cancelled).toBe(false);
    expect(out.results.map(refKey)).toEqual(refs.map(refKey));
  });
  it("works without a progress callback", async () => {
    expect((await runChunks({ refs: refs.slice(0, 2), size: 6, cancelled: () => false, send: approveAll })).results).toHaveLength(2);
  });
  it("marks a chunk that throws as failed with the network message and carries on", async () => {
    let call = 0;
    const out = await runChunks({
      refs, size: 6, cancelled: () => false,
      send: async (part) => { call++; if (call === 2) throw new TypeError("fetch failed"); return approveAll(part); },
    });
    expect(out.results.map((r) => r.status)).toEqual([...Array(6).fill("approved"), ...Array(6).fill("failed"), "approved", "approved"]);
    expect(out.results[6]!.error).toBe(NETWORK_ERROR);
    expect([...retryKeys(out.results)]).toHaveLength(6);
  });
  it("marks a refused chunk as failed with the server's message", async () => {
    const out = await runChunks({ refs: refs.slice(0, 3), size: 6, cancelled: () => false, send: async () => ({ ok: false, error: "Too many approvals." }) });
    expect(out.results.every((r) => r.status === "failed" && r.error === "Too many approvals.")).toBe(true);
  });
  it("fills in failed for an item the server did not answer", async () => {
    const out = await runChunks({ refs: refs.slice(0, 3), size: 6, cancelled: () => false, send: async (part) => ({ ok: true, results: [ok(part[0]!)] }) });
    expect(out.results.map((r) => r.status)).toEqual(["approved", "failed", "failed"]);
    expect(out.results[1]!.error).toBe(NO_ANSWER);
  });
  it("finishes the current chunk when cancelled and returns the rest as not attempted", async () => {
    let stop = false;
    const sent: number[] = [];
    const out = await runChunks({
      refs, size: 6, cancelled: () => stop,
      send: async (part) => { sent.push(part.length); stop = true; return approveAll(part); },
    });
    expect(sent).toEqual([6]);
    expect(out.cancelled).toBe(true);
    expect(out.results.map((r) => r.status)).toEqual([...Array(6).fill("approved"), ...Array(8).fill("not-attempted")]);
    expect(out.results[13]!.error).toBe(CANCELLED);
    expect(retryKeys(out.results).size).toBe(8);
  });
  it("sends nothing for an empty list", async () => {
    const out = await runChunks({ refs: [], size: 6, cancelled: () => false, send: async () => { throw new Error("no"); } });
    expect(out).toEqual({ results: [], cancelled: false });
  });
  it("rejects in chunks of 200", async () => {
    const many = Array.from({ length: 450 }, (_, n) => ref("ingredient", `s${n}`, 1));
    const sizes: number[] = [];
    const out = await runChunks({ refs: many, size: REJECT_CHUNK, cancelled: () => false, send: async (part) => { sizes.push(part.length); return rejectOutcome(part, { ok: true }); } });
    expect(sizes).toEqual([200, 200, 50]);
    expect(tallyResults(out.results).rejected).toBe(450);
  });
  it("passes a refused reject through", () => {
    expect(rejectOutcome([refs[0]!], { ok: false, error: "No." })).toEqual({ ok: false, error: "No." });
  });
});

describe("progress text", () => {
  it("reads naturally while running and when done", () => {
    expect(progressText("approve", { done: 9, total: 23 }, false)).toBe("Approving 9 of 23");
    expect(progressText("approve", { done: 23, total: 23 }, true)).toBe("Approved 23 of 23");
    expect(progressText("reject", { done: 0, total: 400 }, false)).toBe("Rejecting 0 of 400");
    expect(progressText("reject", { done: 400, total: 400 }, true)).toBe("Rejected 400 of 400");
  });
});

describe("URL params", () => {
  it("falls back to the defaults for nothing, junk and repeated values", () => {
    expect(parseReviewParams({})).toEqual(DEFAULT_PARAMS);
    expect(parseReviewParams({ kind: "fruit", status: "x", missing: "yes", page: "-3", q: undefined })).toEqual(DEFAULT_PARAMS);
    expect(parseReviewParams({ page: "abc" }).page).toBe(1);
    expect(parseReviewParams({ kind: ["ingredient", "recipe"], q: ["  tofu  ", "x"] })).toMatchObject({ kind: "ingredient", q: "tofu" });
  });
  it("reads every filter", () => {
    expect(parseReviewParams({ kind: "recipe", status: "decided", missing: "1", q: "falafel", page: "3" })).toEqual({ kind: "recipe", status: "decided", missing: true, q: "falafel", page: 3 });
    expect(parseReviewParams({ q: "x".repeat(300) }).q).toHaveLength(120);
  });
  it("builds the plain URL for defaults and a full one otherwise, and round-trips", () => {
    expect(reviewHref(DEFAULT_PARAMS)).toBe("/photos/review");
    const full = { kind: "ingredient", status: "decided", missing: true, q: "red lentils", page: 2 } as const;
    const href = reviewHref(full);
    expect(href).toBe("/photos/review?kind=ingredient&status=decided&missing=1&q=red+lentils&page=2");
    expect(parseReviewParams(Object.fromEntries(new URL(href, "http://x").searchParams))).toEqual(full);
    expect(reviewHref({ ...DEFAULT_PARAMS, kind: "recipe" })).toBe("/photos/review?kind=recipe");
  });
  it("pages 30 subjects at a time and clamps the page", () => {
    expect(pageWindow(0, 1)).toEqual({ page: 1, pages: 1, start: 0, end: 0 });
    expect(pageWindow(65, 1)).toEqual({ page: 1, pages: 3, start: 0, end: 30 });
    expect(pageWindow(65, 3)).toEqual({ page: 3, pages: 3, start: 60, end: 65 });
    expect(pageWindow(65, 99).page).toBe(3);
    expect(pageWindow(65, 0).page).toBe(1);
    expect(pageWindow(10, 2, 5)).toEqual({ page: 2, pages: 2, start: 5, end: 10 });
  });
});
