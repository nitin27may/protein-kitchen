"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveFood, attachLabelPhoto, deleteFood, restoreFood } from "@/app/foods/actions";
import { LabelPhotoField } from "@/components/foods/LabelPhotoField";
import { Banner, Button, LinkButton } from "@/components/ui";

/** Owner-only controls on a food's page: edit, archive or restore, delete when unused, replace the label photo. */
export function FoodOwnerActions({ uid, archived, usageCount, source, hasPhoto }: {
  uid: string; archived: boolean; usageCount: number; source: "LABEL" | "OFF" | "MANUAL"; hasPhoto: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);

  function run(task: () => Promise<{ ok: boolean; error?: string }>, after: () => void) {
    setError(null);
    start(async () => {
      const r = await task();
      if (!r.ok) { setError(r.error ?? "That did not work."); return; }
      after();
    });
  }

  function savePhoto() {
    if (!photo) return;
    const fd = new FormData();
    fd.set("photo", new File([photo], "label.jpg", { type: "image/jpeg" }));
    run(() => attachLabelPhoto(uid, fd), () => { setPhoto(null); router.refresh(); });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <LinkButton href={`/foods/${uid}/edit`} variant="secondary">Edit</LinkButton>
        {archived
          ? <Button variant="secondary" loading={pending} onClick={() => run(() => restoreFood(uid), () => router.refresh())}>Restore</Button>
          : <Button variant="secondary" loading={pending} onClick={() => run(() => archiveFood(uid), () => router.refresh())}>Archive</Button>}
      </div>
      {source !== "MANUAL" ? (
        <div className="max-w-sm space-y-2">
          <LabelPhotoField existingSrc={hasPhoto ? `/foods/${uid}/label/thumb` : null} file={photo} onChange={setPhoto} disabled={pending} />
          {photo ? <Button loading={pending} onClick={savePhoto}>Save new photo</Button> : null}
        </div>
      ) : (
        <p className="text-sm text-muted">This food was typed without a label photo. To add one, use <a className="font-semibold text-primary underline-offset-2 hover:underline" href={`/foods/${uid}/edit`}>Edit</a>, so you check the numbers against it.</p>
      )}
      <div className="border-t border-line pt-3">
        {usageCount > 0 ? (
          <p className="text-sm text-muted">This food is in the food log, so it cannot be deleted. Archive it to hide it from pickers.</p>
        ) : confirmDelete ? (
          <div className="space-y-2">
            <p className="text-sm">Delete this food and its label photo? This cannot be undone.</p>
            <div className="flex gap-2">
              <Button variant="danger" loading={pending} onClick={() => run(() => deleteFood(uid), () => { router.push("/foods"); router.refresh(); })}>Delete food</Button>
              <Button variant="secondary" disabled={pending} onClick={() => setConfirmDelete(false)}>Keep it</Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
      </div>
      {error ? <Banner tone="bad">{error}</Banner> : null}
    </div>
  );
}
