"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { resizeForUpload } from "@/lib/photos/client-resize";

/**
 * Takes or picks a photo of the pack's nutrition label and shrinks it on the phone. The photo is not sent until the form is
 * saved (or, for a replacement, until the caller sends it): this field only holds the resized picture and shows it beside
 * the numbers, so they can be checked against it. A phone shows a small thumbnail that opens full size.
 */
export function LabelPhotoField({ existingSrc = null, file, onChange, disabled = false }: {
  /** The label photo already stored for this food, shown until a new one is picked. */
  existingSrc?: string | null;
  file: Blob | null;
  onChange: (file: Blob | null) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function onPick(picked: File | undefined) {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await resizeForUpload(picked));
    } catch {
      setError("This phone could not read that photo. Try a JPEG or PNG.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const shown = preview ?? existingSrc;
  return (
    <div>
      <div className="flex items-center gap-3 lg:flex-col lg:items-stretch">
        {shown ? (
          <button type="button" onClick={() => setOpen(true)} aria-label="View the label photo full size"
            className="size-16 shrink-0 overflow-hidden rounded-control border border-line bg-surface2 lg:size-auto lg:w-full">
            <img src={shown} alt="Photo of the nutrition label" className="size-full object-cover lg:max-h-[60vh] lg:object-contain" />
          </button>
        ) : (
          <div className="flex size-16 shrink-0 items-center justify-center rounded-control border border-dashed border-strong bg-surface2 text-center text-xs text-muted lg:h-40 lg:w-full lg:text-sm">
            No photo
          </div>
        )}
        <div className="min-w-0 flex-1 lg:flex-none">
          <p className="text-sm font-semibold">Label photo</p>
          <p className="text-xs text-muted lg:text-sm">{file ? "New photo ready. It is saved with the food." : shown ? "Saved with this food." : "Optional. With one, the food is marked as from the label."}</p>
          <input ref={input} type="file" disabled={!hydrated || disabled} accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true"
            data-testid="label-photo-input" onChange={(e) => void onPick(e.target.files?.[0])} />
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={busy} disabled={!hydrated || disabled} onClick={() => input.current?.click()}>
              {file || shown ? "Replace photo" : "Take or choose photo"}
            </Button>
            {file ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>Remove new photo</Button> : null}
          </div>
        </div>
      </div>
      {error ? <p role="alert" className="mt-1 text-sm text-bad">{error}</p> : null}
      <Sheet open={open} onClose={() => setOpen(false)} title="Label photo" full>
        {shown ? <img src={shown} alt="Photo of the nutrition label, full size" className="mx-auto max-h-full w-full object-contain p-2" /> : null}
      </Sheet>
    </div>
  );
}
