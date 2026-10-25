"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startOwnKitchen } from "@/app/onboarding/actions";
import { Banner, Button } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";

export function StartOwnKitchen() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-3">
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Button variant="secondary" size="lg" disabled={!hydrated} loading={pending} onClick={async () => {
        setPending(true); setError("");
        try {
          const result = await startOwnKitchen();
          if (!result.ok) { setError(result.error); return; }
          router.refresh();
        } catch {
          setError("Your kitchen could not be created. Check your connection and try again.");
        } finally { setPending(false); }
      }}>Start my own kitchen instead</Button>
    </div>
  );
}
