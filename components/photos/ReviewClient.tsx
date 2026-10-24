"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approvePhotoCandidate, rejectPhotoCandidate } from "@/app/actions";
import { Banner, Button, Chip, EmptyState, SearchField } from "@/components/ui";
import type { ReviewItem } from "@/lib/server/photo-review";

type Kind = "all" | "recipe" | "ingredient";

/** Review queue: for each recipe or ingredient, the candidate photos with their source and licence. */
export function ReviewClient({ items, kind, q, missingOnly, waiting }: { items: ReviewItem[]; kind: Kind; q: string; missingOnly: boolean; waiting: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ total: number; done: number; failed: number } | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const go = (next: { kind?: Kind; q?: string; missing?: boolean }) => {
    const p = new URLSearchParams();
    const k = next.kind ?? kind;
    const query = next.q ?? q;
    const m = next.missing ?? missingOnly;
    if (k !== "all") p.set("kind", k);
    if (query) p.set("q", query);
    if (m) p.set("missing", "1");
    router.replace(`/photos/review${p.size ? `?${p}` : ""}`);
  };

  function decide(item: ReviewItem, key: string, action: "approve" | "reject") {
    setError(null);
    setBusyKey(key);
    start(async () => {
      const r = action === "approve" ? await approvePhotoCandidate(item.kind, item.slug, key) : await rejectPhotoCandidate(item.kind, item.slug, key);
      setBusyKey(null);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  // First candidate for every ingredient shown that has no photo yet. One request at a time keeps the provider happy.
  const bulkTargets = items.filter((i) => i.kind === "ingredient" && !i.hasPhoto && i.candidates.length > 0);
  async function approveFirsts() {
    setConfirmBulk(false);
    setError(null);
    setBulk({ total: bulkTargets.length, done: 0, failed: 0 });
    let failed = 0;
    for (let n = 0; n < bulkTargets.length; n++) {
      const t = bulkTargets[n]!;
      const r = await approvePhotoCandidate(t.kind, t.slug, t.candidates[0]!.key);
      if (!r.ok) failed++;
      setBulk({ total: bulkTargets.length, done: n + 1, failed });
    }
    router.refresh();
  }

  return (
    <div className="space-y-4 px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip on={kind === "all"} onClick={() => go({ kind: "all" })}>All</Chip>
        <Chip on={kind === "recipe"} onClick={() => go({ kind: "recipe" })}>Recipes</Chip>
        <Chip on={kind === "ingredient"} onClick={() => go({ kind: "ingredient" })}>Ingredients</Chip>
        <Chip on={missingOnly} onClick={() => go({ missing: !missingOnly })}>Only without a photo</Chip>
      </div>
      <SearchField id="review-search" value={q} onChange={(v) => go({ q: v })} placeholder="Search recipes and ingredients" label="Search photos to review" className="max-w-md" />

      {error ? <Banner tone="bad">{error}</Banner> : null}

      {bulkTargets.length > 1 ? (
        <div className="rounded-card border border-line bg-surface p-3">
          {bulk && bulk.done < bulk.total ? (
            <p role="status" className="text-sm">Approving {bulk.done} of {bulk.total}. Keep this page open.</p>
          ) : bulk ? (
            <p role="status" className="text-sm">Approved {bulk.done - bulk.failed} of {bulk.total}{bulk.failed ? `; ${bulk.failed} could not be fetched and stay in the list` : ""}.</p>
          ) : confirmBulk ? (
            <div className="space-y-2">
              <p className="text-sm">Approve the first photo of each of the {bulkTargets.length} ingredients shown that have none? You can delete any of them later.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void approveFirsts()}>Approve {bulkTargets.length} photos</Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmBulk(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConfirmBulk(true)}>Approve the first photo of {bulkTargets.length} ingredients</Button>
          )}
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title={waiting === 0 ? "Nothing to review" : "No matches"} body={waiting === 0 ? "Every candidate has an answer. Run the candidate script again to look for more." : "Change the filters to see the other photos waiting for you."} />
      ) : (
        <ul className="space-y-6">
          {items.map((item) => (
            <li key={`${item.kind}-${item.slug}`} aria-labelledby={`h-${item.kind}-${item.slug}`}>
              <h2 id={`h-${item.kind}-${item.slug}`} className="mb-2 text-lg font-semibold">
                {item.name} <span className="text-sm font-normal text-muted">{item.kind === "recipe" ? "Recipe" : "Ingredient"}{item.hasPhoto ? ", has a photo" : ", no photo yet"}</span>
              </h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {item.candidates.map((c) => (
                  <li key={c.key} className="overflow-hidden rounded-card border border-line bg-surface">
                    <img src={c.image_url} alt={`${c.title}, candidate photo for ${item.name}`} loading="lazy" referrerPolicy="no-referrer" className="aspect-[4/3] w-full bg-surface2 object-cover" />
                    <div className="space-y-2 p-3">
                      <p className="text-sm font-semibold leading-snug">{c.title}</p>
                      <p className="text-xs text-muted">
                        {c.author}, {c.licence_url ? <a href={c.licence_url} target="_blank" rel="noreferrer" className="underline">{c.licence}</a> : c.licence}, via {c.provider === "commons" ? "Wikimedia Commons" : "Openverse"}. <a href={c.source_url} target="_blank" rel="noreferrer" className="underline">Open the source page</a>
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" loading={busyKey === c.key && pending} disabled={pending} onClick={() => decide(item, c.key, "approve")}>Approve</Button>
                        <Button size="sm" variant="secondary" disabled={pending} onClick={() => decide(item, c.key, "reject")}>Reject</Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
