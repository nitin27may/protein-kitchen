"use client";

import { useState } from "react";
import { Sheet } from "@/components/Sheet";

/** The stored label photo as a thumbnail that opens full size. Served only to the household that owns the food. */
export function LabelPhotoViewer({ uid, name }: { uid: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`View the label photo of ${name} full size`}
        className="block w-full max-w-xs overflow-hidden rounded-card border border-line bg-surface2">
        <img src={`/foods/${uid}/label/thumb`} alt={`Nutrition label of ${name}`} className="w-full object-contain" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Label photo" full>
        <img src={`/foods/${uid}/label/master`} alt={`Nutrition label of ${name}, full size`} className="mx-auto max-h-full w-full object-contain p-2" />
      </Sheet>
    </>
  );
}
