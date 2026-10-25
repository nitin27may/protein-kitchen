"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  // Reading an expired or damaged draft deletes it, so the first answer is kept if React runs the effect twice.
  const first = useRef<{ version: string; profile: AnonProfile | null; load: DraftLoad } | null>(null);

  useEffect(() => {
    if (first.current?.version !== libraryVersion) {
      const stores = browserStores();
      const now = new Date();
      first.current = { version: libraryVersion, profile: loadAnonProfile(stores, now), load: loadAnonDraft(stores, { now, libraryVersion }) };
    }
    setProfile(first.current.profile);
    setLoad(first.current.load);
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
