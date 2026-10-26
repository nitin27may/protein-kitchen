/**
 * Pure logic behind the photo review page: URL filters, paging, the selection set, per-subject cap warnings,
 * chunked runs with cancel and retry, and result merging. No React, no server imports, so the client component stays
 * thin and this file carries the 100% coverage gate.
 */

export type SubjectKind = "recipe" | "ingredient";
export type KindFilter = "all" | SubjectKind;
export type StatusFilter = "pending" | "decided";

export interface ItemRef { kind: SubjectKind; slug: string; key: string }
export type RunStatus = "approved" | "already" | "subject-full" | "not-attempted" | "failed" | "rejected";
export interface RunResult extends ItemRef { status: RunStatus; error?: string }
export type SendOutcome = { ok: true; results: readonly RunResult[] } | { ok: false; error: string };

/** Mirrors APPROVE_BATCH_MAX, REJECT_BATCH_MAX and LIBRARY_PHOTO_CAP on the server; a test keeps them equal. */
export const APPROVE_CHUNK = 6;
export const REJECT_CHUNK = 200;
export const PER_SUBJECT_CAP = 3;
export const PAGE_SIZE = 30;
export const SELECT_ALL_LIMIT = 2000;

export const NETWORK_ERROR = "The request did not finish. Check your connection and try again.";
export const NO_ANSWER = "The server gave no answer for this photo. Try again.";
export const CANCELLED = "Stopped before this photo was tried.";

// ---------------------------------------------------------------- selection keys

/** `kind:slug:key`. The candidate key itself contains colons, so only the first two colons split. */
export const refKey = (ref: ItemRef): string => `${ref.kind}:${ref.slug}:${ref.key}`;
export const subjectKey = (ref: Pick<ItemRef, "kind" | "slug">): string => `${ref.kind}:${ref.slug}`;

export function parseRefKey(value: string): ItemRef | null {
  const first = value.indexOf(":");
  const second = first < 0 ? -1 : value.indexOf(":", first + 1);
  if (second < 0) return null;
  const kind = value.slice(0, first);
  const slug = value.slice(first + 1, second);
  const key = value.slice(second + 1);
  if ((kind !== "recipe" && kind !== "ingredient") || !slug || !key) return null;
  return { kind, slug, key };
}

export function toggleKey(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function setKeys(selection: ReadonlySet<string>, keys: Iterable<string>, on: boolean): Set<string> {
  const next = new Set(selection);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** Keys from one position to the other, both included, in page order. Unknown ends give just the target (or nothing). */
export function rangeKeys(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * A click on a tile. A plain click toggles that tile. A shift-click applies the anchor's state to every tile between
 * the anchor and the clicked one, the way mail lists do. Either way the clicked tile becomes the new anchor.
 */
export function clickTile(selection: ReadonlySet<string>, order: readonly string[], anchor: string | null, key: string, shift: boolean): { selection: Set<string>; anchor: string } {
  if (shift && anchor !== null && anchor !== key && order.includes(anchor)) {
    return { selection: setKeys(selection, rangeKeys(order, anchor, key), selection.has(anchor)), anchor: key };
  }
  return { selection: toggleKey(selection, key), anchor: key };
}

export interface SubjectWithCandidates { kind: SubjectKind; slug: string; candidates: readonly { key: string }[] }

export function pageKeys(items: readonly SubjectWithCandidates[]): string[] {
  return items.flatMap((i) => i.candidates.map((c) => refKey({ kind: i.kind, slug: i.slug, key: c.key })));
}

/** The first candidate of every subject, in page order. */
export function firstOfEach(items: readonly SubjectWithCandidates[]): string[] {
  return items.flatMap((i) => (i.candidates[0] ? [refKey({ kind: i.kind, slug: i.slug, key: i.candidates[0].key })] : []));
}

export interface SelectionCounts { total: number; recipes: number; ingredients: number; subjects: number }

export function countSelection(selection: ReadonlySet<string>): SelectionCounts {
  const subjects = new Set<string>();
  let recipes = 0;
  let ingredients = 0;
  for (const value of selection) {
    const ref = parseRefKey(value);
    if (!ref) continue;
    subjects.add(subjectKey(ref));
    if (ref.kind === "recipe") recipes += 1;
    else ingredients += 1;
  }
  return { total: recipes + ingredients, recipes, ingredients, subjects: subjects.size };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "23 selected (15 recipes, 8 ingredients)". */
export function describeSelection(counts: SelectionCounts): string {
  const parts = [
    ...(counts.recipes ? [plural(counts.recipes, "recipe", "recipes")] : []),
    ...(counts.ingredients ? [plural(counts.ingredients, "ingredient", "ingredients")] : []),
  ];
  return `${counts.total} selected${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function selectionRefs(selection: ReadonlySet<string>): ItemRef[] {
  return [...selection].flatMap((value) => {
    const ref = parseRefKey(value);
    return ref ? [ref] : [];
  });
}

// ---------------------------------------------------------------- per-subject cap

export interface CapWarning { subject: string; selected: number; free: number; message: string }

/**
 * Subjects where more photos are selected than still fit under the cap. `live` holds the approved photo count for the
 * subjects the page has seen; a subject it has not seen counts as empty, and the server has the last word (subject-full).
 */
export function capWarnings(selection: ReadonlySet<string>, live: ReadonlyMap<string, number>, names: ReadonlyMap<string, string> = new Map(), cap = PER_SUBJECT_CAP): CapWarning[] {
  const chosen = new Map<string, number>();
  for (const ref of selectionRefs(selection)) chosen.set(subjectKey(ref), (chosen.get(subjectKey(ref)) ?? 0) + 1);
  const warnings: CapWarning[] = [];
  for (const [subject, selected] of chosen) {
    const free = Math.max(0, cap - (live.get(subject) ?? 0));
    if (selected <= free) continue;
    const name = names.get(subject) ?? subject.slice(subject.indexOf(":") + 1);
    const room = free === 0 ? "already has the most photos it can keep" : `has room for ${plural(free, "more photo", "more photos")}`;
    warnings.push({ subject, selected, free, message: `${name} ${room}, and ${selected} are selected. The extra ones will be reported as full.` });
  }
  return warnings.sort((a, b) => a.message.localeCompare(b.message));
}

// ---------------------------------------------------------------- chunked runs

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let n = 0; n < items.length; n += size) out.push(items.slice(n, n + size));
  return out;
}

export function mergeResults(previous: ReadonlyMap<string, RunResult>, next: readonly RunResult[]): Map<string, RunResult> {
  const merged = new Map(previous);
  for (const result of next) merged.set(refKey(result), result);
  return merged;
}

/** Items to select again after a run: the ones that failed or were never tried. Everything else is settled. */
export function retryKeys(results: Iterable<RunResult>): Set<string> {
  const keys = new Set<string>();
  for (const result of results) if (result.status === "failed" || result.status === "not-attempted") keys.add(refKey(result));
  return keys;
}

export function tallyResults(results: Iterable<RunResult>): Record<RunStatus, number> {
  const tally: Record<RunStatus, number> = { approved: 0, already: 0, "subject-full": 0, "not-attempted": 0, failed: 0, rejected: 0 };
  for (const result of results) tally[result.status] += 1;
  return tally;
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  approved: "Approved",
  already: "Already in the library",
  "subject-full": "Not added: this subject is full",
  "not-attempted": "Not tried",
  failed: "Failed",
  rejected: "Rejected",
};

export interface Progress { done: number; total: number }

const fail = (ref: ItemRef, error: string): RunResult => ({ kind: ref.kind, slug: ref.slug, key: ref.key, status: "failed", error });
const skipped = (ref: ItemRef): RunResult => ({ kind: ref.kind, slug: ref.slug, key: ref.key, status: "not-attempted", error: CANCELLED });

/**
 * Sends the items one chunk at a time. A chunk that throws (network error, aborted request) or is refused as a whole
 * marks only its own items as failed and the run goes on. After `cancelled()` turns true the current chunk finishes and
 * every item not yet sent is returned as not-attempted so it can be queued again. Results come back in input order.
 */
export async function runChunks(options: {
  refs: readonly ItemRef[];
  size: number;
  send: (chunk: ItemRef[]) => Promise<SendOutcome>;
  cancelled: () => boolean;
  onProgress?: (progress: Progress, results: readonly RunResult[]) => void;
}): Promise<{ results: RunResult[]; cancelled: boolean }> {
  const { refs, size, send, cancelled, onProgress } = options;
  const results: RunResult[] = [];
  let stopped = false;
  onProgress?.({ done: 0, total: refs.length }, results);
  for (const part of chunk(refs, size)) {
    if (cancelled()) {
      stopped = true;
      results.push(...part.map(skipped));
      continue;
    }
    let outcome: SendOutcome;
    try {
      outcome = await send(part);
    } catch {
      outcome = { ok: false, error: NETWORK_ERROR };
    }
    if (!outcome.ok) results.push(...part.map((ref) => fail(ref, outcome.error)));
    else {
      const answered = new Map(outcome.results.map((r) => [refKey(r), r] as const));
      results.push(...part.map((ref) => answered.get(refKey(ref)) ?? fail(ref, NO_ANSWER)));
    }
    onProgress?.({ done: results.length, total: refs.length }, results);
  }
  return { results, cancelled: stopped };
}

/** A reject chunk that succeeded rejected all of its items (the server skips ones it does not list). */
export function rejectOutcome(part: readonly ItemRef[], response: { ok: true } | { ok: false; error: string }): SendOutcome {
  return response.ok ? { ok: true, results: part.map((ref) => ({ kind: ref.kind, slug: ref.slug, key: ref.key, status: "rejected" as const })) } : response;
}

/** "Approving 9 of 23" while running (items already answered), "Approved 23 of 23" once done. */
export function progressText(verb: "approve" | "reject", progress: Progress, finished: boolean): string {
  const word = verb === "approve" ? (finished ? "Approved" : "Approving") : finished ? "Rejected" : "Rejecting";
  return `${word} ${progress.done} of ${progress.total}`;
}

// ---------------------------------------------------------------- URL filters and paging

export interface ReviewParams { kind: KindFilter; status: StatusFilter; missing: boolean; q: string; page: number }
export const DEFAULT_PARAMS: ReviewParams = { kind: "all", status: "pending", missing: false, q: "", page: 1 };

type RawParams = Readonly<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export function parseReviewParams(raw: RawParams): ReviewParams {
  const kind = first(raw.kind);
  const page = Number.parseInt(first(raw.page) ?? "", 10);
  return {
    kind: kind === "recipe" || kind === "ingredient" ? kind : "all",
    status: first(raw.status) === "decided" ? "decided" : "pending",
    missing: first(raw.missing) === "1",
    q: (first(raw.q) ?? "").trim().slice(0, 120),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** Default values are left out so the plain page keeps the plain URL `/photos/review`. Any filter change returns to page 1 unless a page is given. */
export function reviewHref(params: ReviewParams): string {
  const query = new URLSearchParams();
  if (params.kind !== "all") query.set("kind", params.kind);
  if (params.status !== "pending") query.set("status", params.status);
  if (params.missing) query.set("missing", "1");
  if (params.q) query.set("q", params.q);
  if (params.page > 1) query.set("page", String(params.page));
  const text = query.toString();
  return text ? `/photos/review?${text}` : "/photos/review";
}

export interface PageWindow { page: number; pages: number; start: number; end: number }

/** The page clamped into range and the slice bounds for `total` subjects. */
export function pageWindow(total: number, page: number, size = PAGE_SIZE): PageWindow {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, start: (current - 1) * size, end: Math.min(total, current * size) };
}
