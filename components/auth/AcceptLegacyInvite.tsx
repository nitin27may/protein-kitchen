"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { joinHousehold } from "@/app/onboarding/actions";
import { Banner, Button } from "@/components/ui";

/** Legacy invitation links only; new people never need a code. */
export function AcceptLegacyInvite({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">You opened an invitation link. Accepting adds you to that household as a member.</p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Button size="lg" loading={pending} onClick={async () => {
        setPending(true); setError("");
        try {
          const result = await joinHousehold("invitation", token);
          if (!result.ok) { setError(result.error); return; }
          router.replace("/onboarding"); router.refresh();
        } catch { setError("Could not accept the invitation. Please try again."); }
        finally { setPending(false); }
      }}>Accept invitation</Button>
    </div>
  );
}
