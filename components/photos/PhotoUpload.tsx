"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadRecipePhoto } from "@/app/actions";
import { useRequireAccount } from "@/components/auth/RequireAccount";
import { Button } from "@/components/ui";
import { resizeForUpload } from "@/lib/photos/client-resize";

/**
 * Picks or takes a photo, shrinks it on the phone, and uploads it to a recipe. Reports a failure in words next to the
 * button; the page refreshes on success so the new photo appears.
 */
export function PhotoUpload({ recipeSlug, label = "Add a photo", variant = "secondary", onUploaded }: { recipeSlug: string; label?: string; variant?: "primary" | "secondary"; onUploaded?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const gate = useRequireAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      let blob: Blob;
      try {
        blob = await resizeForUpload(file);
      } catch {
        setError("This phone could not read that photo. Try a JPEG or PNG.");
        return;
      }
      const form = new FormData();
      form.set("recipe", recipeSlug);
      form.set("photo", new File([blob], "photo.jpg", { type: "image/jpeg" }));
      const r = await uploadRecipePhoto(form);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onUploaded?.();
      router.refresh();
    } catch {
      setError("The photo could not be uploaded. Check your connection and try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div>
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onPick(e.target.files?.[0])} />
      <Button variant={variant} size="sm" loading={busy} onClick={() => { if (gate.require({ intent: { kind: "other", action: "adding a photo" } })) return; input.current?.click(); }}>{busy ? "Uploading" : label}</Button>
      {error ? <p role="alert" className="mt-1 text-sm text-bad">{error}</p> : null}
    </div>
  );
}
