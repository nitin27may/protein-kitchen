import { and, eq, gte, isNull } from "drizzle-orm";
import type { BlobStore } from "../blob/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { approveLibraryCandidate, LIBRARY_PHOTO_CAP, type LibraryApproveInput } from "../human/library-photos";
import type { Candidate, CandidateFile } from "../photos/candidates";
import { PhotoError } from "../photos/process";
import { commonsLicenceProblem, commonsLicences, downloadImage, recheckOpenverse, RemoteError, userAgent } from "../photos/remote";
import type { ReviewFilter, ReviewItem, SubjectKind } from "./photo-review";

export type { ReviewFilter, ReviewItem, SubjectKind } from "./photo-review";

export interface ItemRef { kind: SubjectKind; slug: string; key: string }
export type ItemStatus = "approved" | "already" | "failed" | "not-attempted" | "subject-full";
export interface ItemResult extends ItemRef { status: ItemStatus; error?: string }
export type BatchResult = { ok: true; results: ItemResult[] } | { ok: false; error: string };

/** Most items one approval request may carry; each one is a download and an image encode. */
export const APPROVE_BATCH_MAX = 6;
export const REJECT_BATCH_MAX = 200;
export const PENDING_KEYS_MAX = 2000;
export const RATE_PER_HOUR = 300;
export const RATE_PER_DAY = 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface Budget {
  concurrency: number;
  /** Deadline for one item, all its requests included. */
  itemMs: number;
  /** Deadline for the whole batch (the route allows 120 s, so this leaves room to answer). */
  batchMs: number;
  /** No new item starts after this long. */
  startCutoffMs: number;
  /** Timeout of one HTTP request. */
  requestMs: number;
}
export const DEFAULT_BUDGET: Budget = { concurrency: 3, itemMs: 40_000, batchMs: 75_000, startCutoffMs: 60_000, requestMs: 15_000 };

export interface Deps {
  fetchImpl?: typeof fetch;
  personId?: number | null;
  budget?: Partial<Budget>;
  now?: () => number;
  userAgent?: string;
}

const decisionKey = (kind: string, slug: string, key: string) => `${kind}\u0000${slug}\u0000${key}`;
const subjectMap = (file: CandidateFile, kind: SubjectKind) => file[kind === "recipe" ? "recipes" : "ingredients"];

export function findCandidate(file: CandidateFile, item: ItemRef): Candidate | undefined {
  return subjectMap(file, item.kind)[item.slug]?.find((c) => c.key === item.key);
}

export type SubjectNames = { recipes: ReadonlyMap<string, string>; ingredients: ReadonlyMap<string, string> };

export interface PendingFilter extends ReviewFilter {
  /** Default true. False also lists candidates that were already rejected (never approved ones). */
  pendingOnly?: boolean;
}

/** Candidates waiting for a decision against the LIBRARY tables, grouped by subject, subjects without a photo first. */
export async function pendingLibraryReview(db: Db, file: CandidateFile, names: SubjectNames, filter: PendingFilter = {}): Promise<ReviewItem[]> {
  const decisions = await db.select({ kind: s.libraryPhotoDecisions.subjectKind, slug: s.libraryPhotoDecisions.subjectSlug, key: s.libraryPhotoDecisions.candidateKey, decision: s.libraryPhotoDecisions.decision }).from(s.libraryPhotoDecisions);
  const decided = new Map(decisions.map((d) => [decisionKey(d.kind, d.slug, d.key), d.decision] as const));
  const recipeSlugs = new Map((await db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes)).map((r) => [r.id, r.slug] as const));
  const photoRows = await db.select({ recipeId: s.libraryPhotos.recipeId, ingredientSlug: s.libraryPhotos.ingredientSlug, key: s.libraryPhotos.candidateKey }).from(s.libraryPhotos);
  const photoCounts = new Map<string, number>();
  for (const p of photoRows) {
    const subject = p.recipeId !== null ? `recipe:${recipeSlugs.get(p.recipeId)}` : `ingredient:${p.ingredientSlug}`;
    photoCounts.set(subject, (photoCounts.get(subject) ?? 0) + 1);
  }
  const pendingOnly = filter.pendingOnly ?? true;
  const q = (filter.q ?? "").trim().toLowerCase();

  const items: ReviewItem[] = [];
  for (const [kind, subjectKind, nameMap] of [["recipes", "recipe", names.recipes], ["ingredients", "ingredient", names.ingredients]] as const) {
    if (filter.kind && filter.kind !== "all" && filter.kind !== subjectKind) continue;
    for (const [slug, list] of Object.entries(file[kind])) {
      const name = nameMap.get(slug);
      if (!name) continue;
      if (q && !name.toLowerCase().includes(q) && !slug.includes(q)) continue;
      const shown = list.filter((c) => {
        const decision = decided.get(decisionKey(subjectKind, slug, c.key));
        return pendingOnly ? decision === undefined : decision !== "approved";
      });
      if (shown.length === 0) continue;
      const photoCount = photoCounts.get(`${subjectKind}:${slug}`) ?? 0;
      const hasPhoto = photoCount > 0;
      if (filter.onlyWithoutPhoto && hasPhoto) continue;
      items.push({ kind: subjectKind, slug, name, candidates: shown, hasPhoto, photoCount });
    }
  }
  return items.sort((a, b) => Number(a.hasPhoto) - Number(b.hasPhoto) || a.name.localeCompare(b.name));
}

/** Every matching candidate as {kind, slug, key} for "select all matching", capped. */
export async function listPendingKeys(db: Db, file: CandidateFile, names: SubjectNames, filter: PendingFilter = {}, limit = PENDING_KEYS_MAX): Promise<ItemRef[]> {
  const keys: ItemRef[] = [];
  for (const item of await pendingLibraryReview(db, file, names, filter)) {
    for (const c of item.candidates) {
      if (keys.length >= limit) return keys;
      keys.push({ kind: item.kind, slug: item.slug, key: c.key });
    }
  }
  return keys;
}

/** Approvals this person made in the last hour and day, from the decisions table. */
export async function recentApprovals(db: Db, personId: number | null, nowMs: number): Promise<{ hour: number; day: number }> {
  const who = personId === null ? isNull(s.libraryPhotoDecisions.createdByPersonId) : eq(s.libraryPhotoDecisions.createdByPersonId, personId);
  const rows = await db.select({ at: s.libraryPhotoDecisions.updatedAt }).from(s.libraryPhotoDecisions)
    .where(and(who, eq(s.libraryPhotoDecisions.decision, "approved"), gte(s.libraryPhotoDecisions.updatedAt, new Date(nowMs - DAY_MS).toISOString())));
  const hourAgo = new Date(nowMs - HOUR_MS).toISOString();
  return { day: rows.length, hour: rows.filter((r) => r.at >= hourAgo).length };
}

const RATE_MESSAGE = "That is more approvals than one person can make in an hour or a day. Wait a while and continue.";
const LATER = "Ran out of time before this photo was tried. Try it again.";
const NOT_LISTED = "That photo is no longer in the candidate list.";

/**
 * Approves up to six candidates. The client sends only {kind, slug, key}; the download URL, licence and credit are read
 * from the server's candidate file. Licences are rechecked first (Commons in one api.php call, Openverse one call per
 * id), then up to three items run at once, each under its own deadline inside a batch budget. An item that is not
 * reached or runs out of time changes nothing and is reported as not-attempted so it can be sent again.
 */
export async function approveBatch(db: Db, store: BlobStore, candidates: CandidateFile, items: readonly ItemRef[], deps: Deps = {}): Promise<BatchResult> {
  const budget = { ...DEFAULT_BUDGET, ...deps.budget };
  const clock = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ua = deps.userAgent ?? userAgent();
  const personId = deps.personId ?? null;
  const unique = [...new Map(items.map((i) => [decisionKey(i.kind, i.slug, i.key), i] as const)).values()];
  if (unique.length === 0) return { ok: true, results: [] };
  if (unique.length > APPROVE_BATCH_MAX) return { ok: false, error: `Approve at most ${APPROVE_BATCH_MAX} photos at a time.` };

  const used = await recentApprovals(db, personId, clock());
  if (used.hour + unique.length > RATE_PER_HOUR || used.day + unique.length > RATE_PER_DAY) return { ok: false, error: RATE_MESSAGE };

  const started = clock();
  const batchSignal = AbortSignal.timeout(budget.batchMs);
  const results = new Map<string, ItemResult>();
  const settle = (item: ItemRef, status: ItemStatus, error?: string) => { results.set(decisionKey(item.kind, item.slug, item.key), { kind: item.kind, slug: item.slug, key: item.key, status, ...(error ? { error } : {}) }); };

  // Local checks first: they need no network and spare a download for photos that cannot be approved.
  const recipeIds = new Map((await db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes)).map((r) => [r.slug, r.id] as const));
  const ingredientSlugs = new Set((await db.select({ slug: s.ingredients.slug }).from(s.ingredients)).map((r) => r.slug));
  const live = await db.select({ recipeId: s.libraryPhotos.recipeId, ingredientSlug: s.libraryPhotos.ingredientSlug, key: s.libraryPhotos.candidateKey }).from(s.libraryPhotos);
  const subjectOf = (recipeId: number | null, ingredientSlug: string | null) => (recipeId !== null ? `recipe:${recipeId}` : `ingredient:${ingredientSlug}`);
  const liveKeys = new Set(live.map((p) => `${subjectOf(p.recipeId, p.ingredientSlug)}\u0000${p.key}`));
  const liveCount = new Map<string, number>();
  for (const p of live) liveCount.set(subjectOf(p.recipeId, p.ingredientSlug), (liveCount.get(subjectOf(p.recipeId, p.ingredientSlug)) ?? 0) + 1);

  const todo: { item: ItemRef; candidate: Candidate }[] = [];
  for (const item of unique) {
    const candidate = findCandidate(candidates, item);
    if (!candidate) { settle(item, "failed", NOT_LISTED); continue; }
    const recipeId = item.kind === "recipe" ? recipeIds.get(item.slug) : undefined;
    if (item.kind === "recipe" ? recipeId === undefined : !ingredientSlugs.has(item.slug)) {
      settle(item, "failed", item.kind === "recipe" ? "Recipe not found." : "Ingredient not found.");
      continue;
    }
    const subject = item.kind === "recipe" ? subjectOf(recipeId!, null) : subjectOf(null, item.slug);
    if (liveKeys.has(`${subject}\u0000${item.key}`)) { settle(item, "already"); continue; }
    if ((liveCount.get(subject) ?? 0) >= LIBRARY_PHOTO_CAP) { settle(item, "subject-full", `This ${item.kind} already has ${LIBRARY_PHOTO_CAP} photos.`); continue; }
    todo.push({ item, candidate });
  }

  // One Commons call for every Commons item (at most six, far below the 50 titles the API takes).
  const licenceProblem = new Map<string, string | null>();
  const commons = todo.filter((t) => t.candidate.provider === "commons");
  const titles = commons.map((t) => t.candidate.key.slice("commons:".length));
  try {
    const found = await commonsLicences(titles, fetchImpl, { signal: batchSignal, timeoutMs: budget.requestMs, userAgent: ua });
    commons.forEach((t, n) => licenceProblem.set(t.candidate.key, commonsLicenceProblem(t.candidate, found.get(titles[n]!))));
  } catch (e) {
    for (const t of commons) licenceProblem.set(t.candidate.key, (e as RemoteError).message); // commonsLicences throws RemoteError only
  }

  const aborted = (itemSignal: AbortSignal) => batchSignal.aborted || itemSignal.aborted;

  async function run({ item, candidate }: { item: ItemRef; candidate: Candidate }): Promise<void> {
    const itemSignal = AbortSignal.any([AbortSignal.timeout(budget.itemMs), batchSignal]);
    const opts = { signal: itemSignal, timeoutMs: budget.requestMs, userAgent: ua };
    try {
      let problem = licenceProblem.get(candidate.key) ?? null;
      if (candidate.provider === "openverse") problem = await recheckOpenverse(candidate, fetchImpl, opts);
      if (aborted(itemSignal)) return settle(item, "not-attempted", LATER);
      if (problem) return settle(item, "failed", problem);
      const bytes = await downloadImage(candidate.image_url, fetchImpl, opts);
      if (aborted(itemSignal)) return settle(item, "not-attempted", LATER);
      const input: LibraryApproveInput = {
        candidateKey: candidate.key, subjectKind: item.kind, subjectSlug: item.slug, origin: candidate.provider, bytes,
        credit: { title: candidate.title, author: candidate.author, licence: candidate.licence, licenceUrl: candidate.licence_url, sourceUrl: candidate.source_url },
        licenceCheckedAt: new Date(clock()).toISOString(), personId,
      };
      const result = await approveLibraryCandidate(db, store, input);
      if (result.status === "approved") settle(item, "approved");
      else if (result.status === "exists") settle(item, "already");
      else if (result.status === "subject-full") settle(item, "subject-full", `This ${item.kind} already has ${LIBRARY_PHOTO_CAP} photos.`);
      else settle(item, "failed", item.kind === "recipe" ? "Recipe not found." : "Ingredient not found.");
    } catch (e) {
      if (aborted(itemSignal)) return settle(item, "not-attempted", LATER);
      if (e instanceof RemoteError || e instanceof PhotoError) return settle(item, "failed", e.message);
      console.error("Library photo approval failed unexpectedly.", e instanceof Error ? e.name : "UNKNOWN");
      settle(item, "failed", "That photo could not be saved. Try again.");
    }
  }

  // A small pool: workers pull the next item until none is left; none starts after the cutoff.
  const queue = [...todo];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (batchSignal.aborted || clock() - started >= budget.startCutoffMs) { settle(next.item, "not-attempted", LATER); continue; }
      await run(next);
    }
  };
  await Promise.all(Array.from({ length: Math.min(budget.concurrency, todo.length) }, worker));

  return { ok: true, results: unique.map((i) => results.get(decisionKey(i.kind, i.slug, i.key))!) };
}
