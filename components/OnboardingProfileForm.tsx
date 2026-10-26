"use client";

import { useEffect, useState } from "react";
import { finishProfile } from "@/app/onboarding/actions";
import { ProfileForm, type ProfileInitial } from "@/components/ProfileForm";
import { Banner } from "@/components/ui";
import { browserStores, clearAnonProfile, loadAnonProfile, loadPendingIntent } from "@/lib/plan/anon-draft";
import { profilePrefill } from "@/lib/plan/profile-prefill";
import type { PersonInputData, Result } from "@/app/actions";

/**
 * The onboarding form with the visitor's device profile filled in. Device storage is only readable in the browser, so the
 * form stays disabled until it has been read and then remounts with the values. That way nothing typed is overwritten.
 */
export function OnboardingProfileForm({ nextHref, initial: serverInitial }: { nextHref: string; initial: ProfileInitial }) {
  // Captured once so a server refresh cannot re-run the read and wipe what the person has typed.
  const [initial] = useState(serverInitial);
  const [state, setState] = useState<{ ready: boolean; initial: ProfileInitial; filled: boolean }>({ ready: false, initial, filled: false });

  useEffect(() => {
    let anon = null;
    try { anon = loadAnonProfile(browserStores(), new Date()); } catch { /* storage unavailable: start blank */ }
    const result = profilePrefill(anon, initial);
    setState({ ready: true, ...result });
  }, [initial]);

  async function save(input: PersonInputData): Promise<Result<{ id: number }>> {
    const res = await finishProfile(input);
    if (res.ok) {
      // With a pending action, the replay clears all device state once it has finished; otherwise do it here.
      try {
        const stores = browserStores();
        if (!loadPendingIntent(stores, new Date())) clearAnonProfile(stores);
      } catch { /* nothing to clear */ }
    }
    return res;
  }

  return <>
    {state.filled ? <div className="mx-4 mb-4"><Banner tone="info" title="We filled in what you entered on this device.">Check it and add the rest.</Banner></div> : null}
    <ProfileForm key={state.ready ? "ready" : "loading"} nextHref={nextHref} saveAction={save} initial={state.initial} disabled={!state.ready} />
  </>;
}
