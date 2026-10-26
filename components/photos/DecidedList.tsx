"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeLibraryPhoto, setLibraryCover, undoLibraryRejection } from "@/app/photos/review/actions";
import { Banner, Button, EmptyState, Pill } from "@/components/ui";
import { libraryPhotoUrl, safeHref } from "@/lib/library-photos/model";
import type { DecidedSubject } from "@/lib/server/library-decided";

const LINK = "inline-flex min-h-11 items-center underline";
const PROVIDER_NAME = { commons: "Wikimedia Commons", openverse: "Openverse" } as const;

type Outcome = { ok: true } | { ok: false; error: string };

/** What has been decided: approved library photos (make cover, remove) and rejected candidates (undo). */
export function DecidedList({ subjects, total, waiting }: { subjects: DecidedSubject[]; total: number; waiting: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  function act(id: string, action: () => Promise<Outcome>) {
    setError(null);
    setBusy(id);
    start(async () => {
      try {
        const r = await action();
        if (!r.ok) setError(r.error);
        else {
          setRemoving(null);
          router.refresh();
        }
      } catch {
        setError("That change could not be saved. Check your connection and try again.");
      } finally {
        setBusy(null);
      }
    });
  }

  if (subjects.length === 0) {
    return <EmptyState title="Nothing decided yet" body={waiting > 0 ? "Approved photos and rejected candidates appear here once you have answered some, or change the filters." : "Approved photos and rejected candidates appear here."} />;
  }

  return (
    <div className="space-y-4">
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <p className="text-sm text-muted">{total} {total === 1 ? "subject" : "subjects"} with an answer.</p>
      <ul className="space-y-6">
        {subjects.map((subject) => (
          <li key={`${subject.kind}:${subject.slug}`} aria-labelledby={`d-${subject.kind}-${subject.slug}`}>
            <h2 id={`d-${subject.kind}-${subject.slug}`} className="mb-2 text-lg font-semibold">
              {subject.name} <span className="text-sm font-normal text-muted">{subject.kind === "recipe" ? "Recipe" : "Ingredient"}</span>
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {subject.photos.map((p) => {
                const sourceHref = safeHref(p.sourceUrl);
                const licenceHref = safeHref(p.licenceUrl);
                const confirming = removing === p.uid;
                return (
                  <li key={p.uid} data-state="approved" className="min-w-0 overflow-hidden rounded-card border border-line bg-surface">
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by the app's own library photo route */}
                    <img src={libraryPhotoUrl(p.uid, "thumb")} alt={`${p.title}, approved photo for ${subject.name}`} loading="lazy" className="aspect-[4/3] w-full bg-surface2 object-cover" />
                    <div className="space-y-2 p-3">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
                        {p.title} <Pill tone="ok">{p.isCover ? "Approved, cover" : "Approved"}</Pill>
                      </p>
                      <p className="text-xs text-muted [overflow-wrap:anywhere]">{p.author}, {p.licence}, via {PROVIDER_NAME[p.origin]}.</p>
                      <p className="-mt-1 flex flex-wrap gap-x-4 text-xs">
                        {licenceHref ? <a href={licenceHref} target="_blank" rel="noreferrer" className={LINK}>Licence terms</a> : null}
                        {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" className={LINK}>Open the source page</a> : null}
                      </p>
                      {confirming ? (
                        <div className="space-y-2">
                          <p className="text-sm">Remove this photo from the library? It stops showing to everyone and the candidate is marked rejected.</p>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="danger" loading={busy === `remove:${p.uid}` && pending} disabled={pending} onClick={() => act(`remove:${p.uid}`, () => removeLibraryPhoto(p.uid))}>Confirm remove</Button>
                            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setRemoving(null)}>Keep</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {p.isCover ? null : <Button size="sm" variant="secondary" loading={busy === `cover:${p.uid}` && pending} disabled={pending} onClick={() => act(`cover:${p.uid}`, () => setLibraryCover(p.uid))}>Make cover</Button>}
                          <Button size="sm" variant="danger" disabled={pending} onClick={() => setRemoving(p.uid)}>Remove</Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {subject.rejected.map((c) => {
                const id = `undo:${subject.kind}:${subject.slug}:${c.key}`;
                const sourceHref = safeHref(c.source_url);
                const licenceHref = safeHref(c.licence_url);
                return (
                  <li key={c.key} data-state="rejected" className="min-w-0 overflow-hidden rounded-card border border-line bg-surface">
                    {/* eslint-disable-next-line @next/next/no-img-element -- provider thumbnails are not served by this app */}
                    <img src={c.image_url} alt={`${c.title}, rejected candidate for ${subject.name}`} loading="lazy" referrerPolicy="no-referrer" className="aspect-[4/3] w-full bg-surface2 object-cover opacity-60" />
                    <div className="space-y-2 p-3">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
                        {c.title} <Pill tone="bad">Rejected</Pill>
                      </p>
                      <p className="text-xs text-muted [overflow-wrap:anywhere]">{c.author}, {c.licence}, via {PROVIDER_NAME[c.provider]}.</p>
                      <p className="-mt-1 flex flex-wrap gap-x-4 text-xs">
                        {licenceHref ? <a href={licenceHref} target="_blank" rel="noreferrer" className={LINK}>Licence terms</a> : null}
                        {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" className={LINK}>Open the source page</a> : null}
                      </p>
                      <Button size="sm" variant="secondary" loading={busy === id && pending} disabled={pending} onClick={() => act(id, () => undoLibraryRejection({ kind: subject.kind, slug: subject.slug, key: c.key }))}>Undo reject</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
