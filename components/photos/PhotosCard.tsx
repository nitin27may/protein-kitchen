"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { makeCoverPhoto, removePhoto } from "@/app/actions";
import { PhotoUpload } from "@/components/photos/PhotoUpload";
import { Banner, Button } from "@/components/ui";
import type { PhotoView } from "@/lib/server/photo-index";

/** Your photos of this recipe: the cover first, with set-cover and remove, and an Add button. */
export function PhotosCard({ recipeSlug, photos }: { recipeSlug: string; photos: PhotoView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "That did not work.");
      setConfirm(null);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="photos" className="space-y-3 rounded-card border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="photos" className="text-base font-semibold">Photos</h2>
        <PhotoUpload recipeSlug={recipeSlug} label={photos.length ? "Add another" : "Add a photo"} />
      </div>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {photos.length === 0 ? <p className="text-sm text-muted">No photo yet. Add one after you cook it; it becomes the picture for this recipe.</p> : null}
      <ul className="grid grid-cols-2 gap-3">
        {photos.map((p) => (
          <li key={p.uid} className="overflow-hidden rounded-control border border-line">
            <img src={p.thumbUrl} alt="" loading="lazy" width={p.width} height={p.height} className="aspect-[4/3] w-full object-cover" />
            <div className="space-y-1 p-2">
              <p className="text-xs text-muted">
                {p.isCover ? <strong className="font-semibold text-fg">Cover. </strong> : null}
                {p.origin === "upload" ? "Your photo" : `${p.author ?? "Unknown author"}, ${p.licence ?? "licence not recorded"}`}
              </p>
              {confirm === p.uid ? (
                <div className="flex gap-2">
                  <Button variant="danger" size="sm" disabled={pending} onClick={() => run(() => removePhoto(p.uid))}>Delete photo</Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Keep</Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {!p.isCover ? <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(() => makeCoverPhoto(p.uid))}>Make cover</Button> : null}
                  <Button variant="secondary" size="sm" onClick={() => setConfirm(p.uid)}>Delete</Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
