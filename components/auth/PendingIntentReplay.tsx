"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { replayPendingIntent } from "@/app/actions";
import { Banner, Button } from "@/components/ui";
import { applyOutcome, describeReplay, readPendingWork, type ReplayOutcome, type ReplayWire } from "@/lib/auth/signup-gate";
import { browserStores } from "@/lib/plan/anon-draft";

// One replay at a time per page load, even if React runs the effect twice in development.
let running = false;

/**
 * Mounted in the shell for signed-in members. When the device holds an action started before signup, it finishes it
 * through the server action, clears the device copy, and takes the person to the result. Failures return the person to
 * the page they were on with a message, and keep the plan draft so they can try again.
 */
export function PendingIntentReplay() {
  const router = useRouter();
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null);

  useEffect(() => {
    if (running) return;
    const stores = browserStores();
    const work = readPendingWork(stores, new Date());
    if (!work) return;
    running = true;
    void (async () => {
      let result: ReplayOutcome;
      if (work.draftProblem) {
        result = { status: "failed", redirectTo: work.intent.returnTo, message: work.draftProblem, clear: "intent" };
      } else {
        try {
          const wire = (await replayPendingIntent(work.intent, work.draft ?? undefined)) as ReplayWire;
          result = describeReplay(work.intent, wire);
        } catch {
          result = { status: "failed", redirectTo: work.intent.returnTo, message: "Your account is ready, but the saved action could not be finished. Repeat it from the page.", clear: "intent" };
        }
      }
      applyOutcome(stores, result);
      setOutcome(result);
      router.push(result.redirectTo);
      router.refresh();
    })().finally(() => { running = false; });
  }, [router]);

  if (!outcome) return null;
  return (
    <div className="fixed inset-x-0 bottom-20 z-50 mx-auto w-full max-w-md px-4 lg:bottom-6" data-testid="replay-notice">
      <Banner tone={outcome.status === "done" ? "ok" : outcome.status === "failed" ? "bad" : "info"}>
        <p>{outcome.message}</p>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => setOutcome(null)}>Dismiss</Button>
      </Banner>
    </div>
  );
}
