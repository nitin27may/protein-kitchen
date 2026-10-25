"use client";

import { useCallback, useEffect, useState } from "react";
import { ANON_LIBRARY_PATH, hydrateAnonLibrary, type AnonLibrary } from "@/lib/plan/anon-library";

let cached: Promise<AnonLibrary> | null = null;

/** Fetches the public library payload once per page load. A failure is not cached, so the next call tries again. */
export function loadAnonLibrary(): Promise<AnonLibrary> {
  if (!cached) {
    cached = fetch(ANON_LIBRARY_PATH, { credentials: "omit" })
      .then((res) => {
        if (!res.ok) throw new Error("The recipe library could not be loaded.");
        return res.json() as Promise<unknown>;
      })
      .then(hydrateAnonLibrary)
      .catch((error: unknown) => {
        cached = null;
        throw error instanceof Error ? error : new Error("The recipe library could not be loaded.");
      });
  }
  return cached;
}

export type AnonLibraryState =
  | { status: "loading" }
  | { status: "ready"; library: AnonLibrary }
  | { status: "error"; message: string };

export function useAnonLibrary(): AnonLibraryState & { retry: () => void } {
  const [state, setState] = useState<AnonLibraryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadAnonLibrary().then(
      (library) => { if (live) setState({ status: "ready", library }); },
      (error: Error) => { if (live) setState({ status: "error", message: error.message }); },
    );
    return () => { live = false; };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
