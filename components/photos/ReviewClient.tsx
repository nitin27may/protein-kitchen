"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { approveLibraryBatch, listPendingKeys, rejectLibraryBatch } from "@/app/photos/review/actions";
import { DecidedList } from "@/components/photos/DecidedList";
import { CheckIcon } from "@/components/icons";
import { Banner, Button, Chip, EmptyState, SearchField } from "@/components/ui";
import { safeHref } from "@/lib/library-photos/model";
import type { DecidedSubject } from "@/lib/server/library-decided";
import {
  APPROVE_CHUNK, capWarnings, clickTile, countSelection, describeSelection, firstOfEach, mergeResults, pageKeys, progressText, refKey,
  rejectOutcome, REJECT_CHUNK, retryKeys, reviewHref, runChunks, selectionRefs, setKeys, STATUS_LABEL, subjectKey, tallyResults,
  type ItemRef, type PageWindow, type Progress, type ReviewParams, type RunResult, type RunStatus, type SendOutcome,
} from "@/lib/photos/review-selection";

export interface ReviewCandidate {
  key: string;
  provider: "commons" | "openverse";
  title: string;
  author: string;
  licence: string;
  licence_url: string | null;
  source_url: string;
  image_url: string;
}
export interface ReviewSubject { kind: "recipe" | "ingredient"; slug: string; name: string; hasPhoto: boolean; photoCount: number; candidates: ReviewCandidate[] }

type Verb = "approve" | "reject";
interface Run { verb: Verb; phase: "running" | "done"; progress: Progress; results: Map<string, RunResult>; stopped: boolean; tally: Record<RunStatus, number> | null }

const PROVIDER_NAME = { commons: "Wikimedia Commons", openverse: "Openverse" } as const;
const LINK = "inline-flex min-h-11 items-center underline";
const pluralPhotos = (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`;

async function sendApprove(items: ItemRef[]): Promise<SendOutcome> {
  const r = await approveLibraryBatch({ items });
  return r.ok ? { ok: true, results: r.results } : { ok: false, error: r.error };
}
async function sendReject(items: ItemRef[]): Promise<SendOutcome> {
  return rejectOutcome(items, await rejectLibraryBatch({ items }));
}

/** Review queue. Pending: pick candidates (one at a time, a range, a page, everything matching) and approve or reject them together. Decided: undo, remove, make cover. */
export function ReviewClient({ view, params, items, decided, window: win, totalSubjects, matching, waiting }: {
  view: "pending" | "decided"; params: ReviewParams; items: ReviewSubject[]; decided: DecidedSubject[]; window: PageWindow; totalSubjects: number; matching: number; waiting: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [run, setRun] = useState<Run | null>(null);
  const [confirm, setConfirm] = useState<Verb | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState(params.q);
  const anchor = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeReason = useRef<"cancel" | "go">("cancel");
  // What the page has shown so far in this session: used for cap warnings and readable result lines.
  const seen = useRef({ live: new Map<string, number>(), names: new Map<string, string>(), titles: new Map<string, string>() });

  for (const item of items) {
    seen.current.live.set(subjectKey(item), item.photoCount);
    seen.current.names.set(subjectKey(item), item.name);
    for (const c of item.candidates) seen.current.titles.set(refKey({ kind: item.kind, slug: item.slug, key: c.key }), c.title);
  }

  const order = useMemo(() => pageKeys(items), [items]);
  const counts = countSelection(selection);
  const running = run?.phase === "running";
  const warnings = useMemo(() => capWarnings(selection, seen.current.live, seen.current.names), [selection, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const overCap = useMemo(() => new Map(warnings.map((w) => [w.subject, w.message] as const)), [warnings]);

  const go = (next: Partial<ReviewParams>) => { router.replace(reviewHref({ ...params, page: 1, ...next })); };

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === params.q) return;
    const timer = setTimeout(() => router.replace(reviewHref({ ...params, q: trimmed, page: 1 })), 350);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirm && !dialog.open) dialog.showModal();
    if (!confirm && dialog.open) dialog.close();
  }, [confirm]);

  // ------------------------------------------------------------ single items

  function decide(subject: ReviewSubject, key: string, action: Verb) {
    setError(null);
    setBusyKey(`${subject.kind}:${subject.slug}:${key}:${action}`);
    start(async () => {
      try {
        const ref: ItemRef = { kind: subject.kind, slug: subject.slug, key };
        const outcome = action === "approve" ? await sendApprove([ref]) : await sendReject([ref]);
        const first = outcome.ok ? outcome.results[0] : undefined;
        const problem = !outcome.ok ? outcome.error : !first || first.status === "failed" || first.status === "not-attempted" || first.status === "subject-full" ? (first?.error ?? "The photo could not be approved.") : null;
        if (problem) setError(problem);
        else {
          setSelection((current) => setKeys(current, [refKey(ref)], false));
          router.refresh();
        }
      } catch {
        setError("The photo decision could not be saved. Check your connection and try again.");
      } finally {
        setBusyKey(null);
      }
    });
  }

  // ------------------------------------------------------------ selection

  function onTile(key: string, shift: boolean) {
    const next = clickTile(selection, order, anchor.current, key, shift);
    anchor.current = next.anchor;
    setSelection(next.selection);
  }
  function selectShown() { setSelection(setKeys(selection, order, true)); }
  function selectFirsts() { setSelection(setKeys(selection, firstOfEach(items), true)); }
  function clear() { setSelection(new Set()); anchor.current = null; setNotice(null); }
  async function selectMatching() {
    setSelecting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await listPendingKeys({ kind: params.kind, q: params.q, onlyWithoutPhoto: params.missing, pendingOnly: true });
      if (!r.ok) setError(r.error);
      else {
        setSelection((current) => setKeys(current, r.keys.map(refKey), true));
        if (r.truncated) setNotice(`Selected the first ${r.keys.length} photos. Narrow the filters to reach the rest.`);
      }
    } catch {
      setError("The list of matching photos could not be loaded. Check your connection and try again.");
    } finally {
      setSelecting(false);
    }
  }

  // ------------------------------------------------------------ runs

  function ask(verb: Verb, button: HTMLButtonElement) {
    opener.current = button;
    closeReason.current = "cancel";
    setConfirm(verb);
  }
  function closeDialog(reason: "cancel" | "go") {
    closeReason.current = reason;
    setConfirm(null);
  }
  function onDialogClosed() {
    setConfirm(null);
    if (closeReason.current === "cancel") opener.current?.focus();
    else barRef.current?.focus();
  }

  async function startRun(verb: Verb, retry: boolean) {
    const refs = selectionRefs(selection);
    if (refs.length === 0) return;
    cancelRequested.current = false;
    setError(null);
    setNotice(null);
    const base = retry && run ? run.results : new Map<string, RunResult>();
    setRun({ verb, phase: "running", progress: { done: 0, total: refs.length }, results: base, stopped: false, tally: null });
    const out = await runChunks({
      refs, size: verb === "approve" ? APPROVE_CHUNK : REJECT_CHUNK, send: verb === "approve" ? sendApprove : sendReject,
      cancelled: () => cancelRequested.current,
      onProgress: (progress) => setRun((current) => (current ? { ...current, progress } : current)),
    });
    const results = mergeResults(base, out.results);
    setRun({ verb, phase: "done", progress: { done: out.results.length, total: refs.length }, results, stopped: out.cancelled, tally: tallyResults(out.results) });
    setSelection(retryKeys(out.results));
    router.refresh();
  }

  const finishedTally = run?.phase === "done" ? tallyResults(run.results.values()) : null;
  const retryCount = run?.phase === "done" ? retryKeys(run.results.values()).size : 0;
  const mine = run?.tally ?? null; // this run only; the results list below also holds earlier runs after a retry
  const statusText = run
    ? run.phase === "running" || !mine
      ? `${progressText(run.verb, run.progress, false)}${cancelRequested.current ? ". Stopping after this group" : ""}`
      : [
        progressText(run.verb, { done: mine.approved + mine.already + mine.rejected, total: run.progress.total }, true),
        ...(mine.failed ? [`${mine.failed} failed`] : []),
        ...(mine["not-attempted"] ? [`${mine["not-attempted"]} not tried`] : []),
        ...(mine["subject-full"] ? [`${mine["subject-full"]} subject full`] : []),
      ].join(". ")
    : describeSelection(counts);
  const resultLabel = (r: RunResult) => `${seen.current.titles.get(refKey(r)) ?? r.key} (${seen.current.names.get(subjectKey(r)) ?? r.slug})`;

  return (
    <div className="space-y-4 px-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
          <Chip on={view === "pending"} onClick={() => go({ status: "pending" })}>Pending</Chip>
          <Chip on={view === "decided"} onClick={() => go({ status: "decided" })}>Decided</Chip>
        </div>
        <div role="group" aria-label="Kind" className="flex flex-wrap gap-2">
          <Chip on={params.kind === "all"} onClick={() => go({ kind: "all" })}>All</Chip>
          <Chip on={params.kind === "recipe"} onClick={() => go({ kind: "recipe" })}>Recipes</Chip>
          <Chip on={params.kind === "ingredient"} onClick={() => go({ kind: "ingredient" })}>Ingredients</Chip>
        </div>
        <Chip on={params.missing} onClick={() => go({ missing: !params.missing })}>Only without a photo</Chip>
      </div>
      <SearchField id="review-search" value={text} onChange={setText} placeholder="Search recipes and ingredients" label="Search photos to review" className="max-w-md" />

      {error ? <Banner tone="bad">{error}</Banner> : null}

      {view === "pending" && items.length > 0 ? (
        <div role="group" aria-label="Selection" className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={running} onClick={selectShown}>Select all shown</Button>
          <Button size="sm" variant="secondary" disabled={running || selecting || matching === 0} loading={selecting} onClick={() => void selectMatching()}>Select all {matching} matching</Button>
          <Button size="sm" variant="secondary" disabled={running} onClick={selectFirsts}>Select first photo of each subject</Button>
          <Button size="sm" variant="ghost" disabled={running || counts.total === 0} onClick={clear}>Clear</Button>
        </div>
      ) : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}

      {run?.phase === "done" ? (
        <section ref={resultsRef} id="review-results" tabIndex={-1} aria-labelledby="review-results-title" className="rounded-card border border-line bg-surface p-3">
          <h2 id="review-results-title" className="text-base font-semibold">Results</h2>
          <p className="mt-1 text-sm text-muted">
            {(["approved", "rejected", "already", "subject-full", "not-attempted", "failed"] as const).filter((s) => finishedTally![s] > 0).map((s) => `${finishedTally![s]} ${STATUS_LABEL[s].toLowerCase()}`).join(", ") || "Nothing was sent."}
          </p>
          <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto text-sm">
            {[...run.results.values()].map((r) => (
              <li key={refKey(r)} data-status={r.status} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
                <span className="shrink-0 font-semibold sm:w-48">{STATUS_LABEL[r.status]}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{resultLabel(r)}{r.error ? <span className="block text-muted">{r.error}</span> : null}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            {retryCount > 0 ? <Button size="sm" onClick={() => void startRun(run.verb, true)}>Retry failed ({retryCount})</Button> : null}
            <Button size="sm" variant="secondary" onClick={() => setRun(null)}>Dismiss results</Button>
          </div>
        </section>
      ) : null}

      {view === "decided" ? (
        <DecidedList subjects={decided} total={totalSubjects} waiting={waiting} />
      ) : items.length === 0 ? (
        <EmptyState title={waiting === 0 ? "Nothing to review" : "No matches"} body={waiting === 0 ? "Every candidate has an answer. Run the candidate script again to look for more." : "Change the filters to see the other photos waiting for you."} />
      ) : (
        <ul className="space-y-6">
          {items.map((item) => {
            const subject = subjectKey(item);
            return (
              <li key={subject} aria-labelledby={`h-${item.kind}-${item.slug}`}>
                <h2 id={`h-${item.kind}-${item.slug}`} className="mb-2 text-lg font-semibold">
                  {item.name} <span className="text-sm font-normal text-muted">{item.kind === "recipe" ? "Recipe" : "Ingredient"}{item.hasPhoto ? `, has ${item.photoCount} of 3 photos` : ", no photo yet"}</span>
                </h2>
                {overCap.has(subject) ? <p className="mb-2 text-sm text-warn">{overCap.get(subject)}</p> : null}
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {item.candidates.map((c) => {
                    const id = refKey({ kind: item.kind, slug: item.slug, key: c.key });
                    const on = selection.has(id);
                    const licenceHref = safeHref(c.licence_url);
                    const sourceHref = safeHref(c.source_url);
                    return (
                      <li key={c.key} className={`min-w-0 overflow-hidden rounded-card border bg-surface ${on ? "border-primary ring-2 ring-primary" : "border-line"}`}>
                        <label className="relative block min-h-11 cursor-pointer has-[input:focus-visible]:outline has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-primary">
                          <input
                            type="checkbox" checked={on} disabled={running} data-ref={id} onChange={() => undefined}
                            onClick={(e) => onTile(id, e.shiftKey)}
                            aria-label={`Select ${c.title} for ${item.name}`}
                            className="absolute left-2 top-2 z-10 size-6 cursor-pointer accent-primary"
                          />
                          {/* eslint-disable-next-line @next/next/no-img-element -- provider thumbnails are not served by this app */}
                          <img src={c.image_url} alt={`${c.title}, candidate photo for ${item.name}`} loading="lazy" referrerPolicy="no-referrer" className="aspect-[4/3] w-full bg-surface2 object-cover" />
                          {on ? <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-primary text-primaryfg" aria-hidden="true"><CheckIcon className="size-4" /></span> : null}
                          <span className="block px-3 pt-2 text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{c.title}</span>
                        </label>
                        <div className="space-y-2 p-3 pt-1">
                          <p className="text-xs text-muted [overflow-wrap:anywhere]">{c.author}, {c.licence}, via {PROVIDER_NAME[c.provider]}.</p>
                          <p className="-mt-1 flex flex-wrap gap-x-4 text-xs">
                            {licenceHref ? <a href={licenceHref} target="_blank" rel="noreferrer" className={LINK}>Licence terms</a> : null}
                            {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" className={LINK}>Open the source page</a> : null}
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" loading={busyKey === `${id}:approve` && pending} disabled={pending || running} onClick={() => decide(item, c.key, "approve")}>Approve</Button>
                            <Button size="sm" variant="secondary" loading={busyKey === `${id}:reject` && pending} disabled={pending || running} onClick={() => decide(item, c.key, "reject")}>Reject</Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {win.pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3">
          {win.page > 1 ? <Link href={reviewHref({ ...params, page: win.page - 1 })} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 text-sm font-semibold">Previous</Link> : <span />}
          <p className="text-center text-sm text-muted">Page {win.page} of {win.pages}, {totalSubjects} {totalSubjects === 1 ? "subject" : "subjects"}</p>
          {win.page < win.pages ? <Link href={reviewHref({ ...params, page: win.page + 1 })} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 text-sm font-semibold">Next</Link> : <span />}
        </nav>
      ) : null}

      {counts.total > 0 || run ? (
        <div
          ref={barRef} tabIndex={-1} role="region" aria-label="Selection actions"
          className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 border-t border-line bg-surface/95 px-4 py-2 backdrop-blur lg:bottom-0 lg:mx-0 lg:rounded-card lg:border"
        >
          <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2">
            <p role="status" aria-live="polite" className="min-w-0 flex-1 basis-48 text-sm font-semibold">{statusText}</p>
            {running ? (
              <Button size="sm" variant="secondary" disabled={cancelRequested.current} onClick={() => { cancelRequested.current = true; setRun((r) => (r ? { ...r } : r)); }}>Cancel</Button>
            ) : (
              <>
                {run ? <Button size="sm" variant="ghost" onClick={() => { resultsRef.current?.scrollIntoView({ block: "start" }); resultsRef.current?.focus(); }}>Show results</Button> : null}
                {counts.total > 0 ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={clear}>Clear selection</Button>
                    <Button size="sm" variant="secondary" onClick={(e) => ask("reject", e.currentTarget)}>Reject selected</Button>
                    <Button size="sm" onClick={(e) => ask("approve", e.currentTarget)}>Approve selected</Button>
                  </>
                ) : null}
              </>
            )}
          </div>
          {!running && warnings.length > 0 && counts.total > 0 ? (
            <p className="pb-1 text-xs text-warn">{warnings.length === 1 ? warnings[0]!.message : `${warnings.length} subjects have more photos selected than they have room for. The extra ones will be reported as full.`}</p>
          ) : null}
        </div>
      ) : null}

      <dialog
        ref={dialogRef} aria-labelledby="review-confirm-title" onClose={onDialogClosed} onCancel={() => { closeReason.current = "cancel"; }}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-4 text-fg shadow-pop backdrop:bg-black/50"
      >
        {confirm ? (
          <div className="space-y-3">
            <h2 id="review-confirm-title" className="text-lg font-semibold">{confirm === "approve" ? "Approve" : "Reject"} {pluralPhotos(counts.total)}?</h2>
            <p className="text-sm">{describeSelection(counts)} across {counts.subjects} {counts.subjects === 1 ? "subject" : "subjects"}.</p>
            <p className="text-sm text-muted">
              {confirm === "approve" ? "They will show to everyone, including visitors without an account." : "They leave this list. You can undo a rejection in the Decided view."}
            </p>
            {confirm === "approve" && warnings.length > 0 ? <p className="text-sm text-warn">{warnings.length} {warnings.length === 1 ? "subject has" : "subjects have"} more photos selected than room for. The server keeps at most 3 per subject.</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => closeDialog("cancel")}>Cancel</Button>
              <Button onClick={() => { closeDialog("go"); void startRun(confirm, false); }}>{confirm === "approve" ? "Approve" : "Reject"} {pluralPhotos(counts.total)}</Button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
