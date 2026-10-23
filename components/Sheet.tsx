"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { XIcon } from "@/components/icons";

/**
 * Bottom sheet on the native <dialog> element: focus is trapped and Escape closes it.
 * `side="right"` makes it a drawer on wide screens (filters, details); phones still get the bottom sheet.
 */
export function Sheet({ open, onClose, title, children, full = false, side }: { open: boolean; onClose: () => void; title: string; children: ReactNode; full?: boolean; side?: "right" }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`sheet ${full ? "full" : ""} ${side === "right" ? "right" : ""}`}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={`flex flex-col ${full || side === "right" ? "h-full" : ""}`} style={{ maxHeight: "inherit" }}>
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2 lg:px-5">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="flex size-11 items-center justify-center rounded-control text-muted hover:bg-surface2 hover:text-fg lg:size-10" aria-label={`Close ${title}`}>
            <XIcon className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{open ? children : null}</div>
      </div>
    </dialog>
  );
}
