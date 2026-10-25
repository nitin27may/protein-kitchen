"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptHouseholdEmailAssociation, declineHouseholdEmailAssociation } from "@/app/onboarding/actions";
import { Banner, Button } from "@/components/ui";

export function EmailAssociationPrompt({ associations }: { associations: { id: string }[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!associations.length) return null;

  async function respond(id: string, accept: boolean) {
    setPendingId(id);
    setError("");
    try {
      const result = accept
        ? await acceptHouseholdEmailAssociation(id)
        : await declineHouseholdEmailAssociation(id);
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    } catch {
      setError("Could not update this household association. Refresh and try again.");
    } finally {
      setPendingId(null);
    }
  }

  return <section aria-labelledby="email-associations-title" className="space-y-3 rounded-card border border-line p-4">
    <h2 id="email-associations-title" className="text-lg font-semibold">Household email association</h2>
    <p className="text-sm text-muted">A household has added this verified email address. Its details stay private until you accept.</p>
    {error ? <Banner tone="bad">{error}</Banner> : null}
    {associations.map(({ id }) => <div key={id} className="flex flex-wrap gap-2">
      <Button loading={pendingId === id} disabled={pendingId !== null} onClick={() => void respond(id, true)}>
        Accept and join
      </Button>
      <Button variant="secondary" disabled={pendingId !== null} onClick={() => void respond(id, false)}>
        Decline
      </Button>
    </div>)}
  </section>;
}
