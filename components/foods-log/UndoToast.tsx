"use client";

import { useEffect } from "react";

export interface ToastState {
  id: number;
  message: string;
  /** Present when the change can be undone. */
  undo?: () => Promise<string | null>;
}

const VISIBLE_MS = 10_000;

/** A short confirmation with an optional Undo. It sits above the bottom navigation and clears itself. */
export function UndoToast({ toast, busy, error, onUndo, onDismiss }: { toast: ToastState | null; busy: boolean; error: string | null; onUndo: () => void; onDismiss: () => void }) {
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);
  if (!toast) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-md items-center gap-2 rounded-card border border-line bg-surface p-2 pl-4 shadow-lg lg:bottom-6">
      <p className="min-w-0 flex-1 text-sm">{error ?? toast.message}</p>
      {toast.undo ? (
        <button type="button" onClick={onUndo} disabled={busy} className="min-h-11 shrink-0 rounded-control px-3 text-sm font-semibold text-primary hover:bg-primarysoft disabled:opacity-50">Undo</button>
      ) : null}
      <button type="button" onClick={onDismiss} className="min-h-11 shrink-0 rounded-control px-3 text-sm font-semibold text-muted hover:bg-surface2" aria-label="Dismiss message">Close</button>
    </div>
  );
}
