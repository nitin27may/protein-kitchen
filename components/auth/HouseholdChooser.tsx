"use client";

import { useState } from "react";
import { chooseHousehold } from "@/app/onboarding/actions";
import { Banner, Button } from "@/components/ui";

export function HouseholdChooser({ households, selectedHouseholdId, selectionUnavailable }: {
  households: { id: string; name: string }[];
  selectedHouseholdId: string | null;
  selectionUnavailable: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function select(id: string) {
    setPending(id); setError("");
    try {
      const result = await chooseHousehold(id);
      if (!result.ok) { setError(result.error); return; }
      window.location.replace(result.profileComplete ? "/account" : "/onboarding");
    } catch {
      setError("The household could not be selected. Check your connection and try again.");
    } finally { setPending(null); }
  }
  return <section aria-label="Choose a household" className="space-y-4">
    <p>Your meal profile, shared plan and shopping list stay in each household. This changes only this signed-in session.</p>
    {selectionUnavailable ? <Banner tone="bad">Your previous household is no longer available. Choose another household to continue.</Banner> : null}
    {error ? <Banner tone="bad">{error}</Banner> : null}
    {households.map((household) => <div key={household.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-4">
      <p className="min-w-0 break-words font-semibold">{household.name}{household.id === selectedHouseholdId ? " (current)" : ""}</p>
      <Button className="max-w-full whitespace-normal text-left" disabled={pending !== null} loading={pending === household.id}
        onClick={() => void select(household.id)} aria-label={`Use household: ${household.name}`}>Use this household</Button>
    </div>)}
    {!households.length ? <p>No household memberships are available. Continue household setup from onboarding.</p> : null}
  </section>;
}
