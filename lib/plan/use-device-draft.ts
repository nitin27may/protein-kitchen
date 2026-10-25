"use client";

import { useCallback, useEffect, useState } from "react";
import { useAnonLibrary } from "@/lib/library/use-anon-library";
import {
  browserStores, clearAnonDraft, clearAnonProfile, loadAnonDraft, loadAnonProfile, saveAnonDraft,
  type AnonDraft, type AnonProfile, type DraftLoad,
} from "./anon-draft";

/**
 * The visitor's plan draft as React state. Storage is read after hydration (the server cannot see it), so the first
 * state is "loading". `commit` stores an edited draft; `discard` removes the draft and the profile.
 */
export function useDeviceDraft(libraryVersion: string) {
  const [load, setLoad] = useState<DraftLoad | { status: "loading" }>({ status: "loading" });
  const [profile, setProfile] = useState<AnonProfile | null>(null);
  const library = useAnonLibrary();

  useEffect(() => {
    const stores = browserStores();
    const now = new Date();
    setProfile(loadAnonProfile(stores, now));
    setLoad(loadAnonDraft(stores, { now, libraryVersion }));
  }, [libraryVersion]);

  const commit = useCallback((draft: AnonDraft): boolean => {
    if (!saveAnonDraft(browserStores(), draft)) return false;
    setLoad({ status: "ok", draft });
    return true;
  }, []);

  const discard = useCallback(() => {
    const stores = browserStores();
    clearAnonDraft(stores);
    clearAnonProfile(stores);
    setLoad({ status: "none" });
  }, []);

  return { load, profile, library, commit, discard };
}
