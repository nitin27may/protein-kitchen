"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { UndoToast, type ToastState } from "./UndoToast";

interface FoodLogContext {
  /** Shows a message. With `undo`, the toast offers Undo; the page refreshes after a successful one. */
  show(message: string, undo?: ToastState["undo"]): void;
  refresh(): void;
}

const Ctx = createContext<FoodLogContext | null>(null);

export function useFoodLog(): FoodLogContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFoodLog must be used inside FoodLogProvider.");
  return ctx;
}

/** Holds the one toast for the page, so it survives the refresh that removes the row that raised it. */
export function FoodLogProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  const refresh = useCallback(() => router.refresh(), [router]);
  const show = useCallback((message: string, undo?: ToastState["undo"]) => {
    counter.current += 1;
    setError(null);
    setToast({ id: counter.current, message, ...(undo ? { undo } : {}) });
  }, []);
  const dismiss = useCallback(() => { setToast(null); setError(null); }, []);
  const undo = useCallback(async () => {
    if (!toast?.undo) return;
    setBusy(true);
    const failure = await toast.undo();
    setBusy(false);
    if (failure) { setError(failure); return; }
    setToast(null);
    router.refresh();
  }, [toast, router]);

  const value = useMemo(() => ({ show, refresh }), [show, refresh]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <UndoToast toast={toast} busy={busy} error={error} onUndo={() => void undo()} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}
