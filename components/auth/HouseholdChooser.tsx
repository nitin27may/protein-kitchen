"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { chooseHousehold } from "@/app/onboarding/actions";
import { renameHousehold } from "@/app/households/actions";
import { Banner, Button, Field, Input } from "@/components/ui";

export function HouseholdChooser({ households, selectedHouseholdId, selectionUnavailable }: {
  households: { id: string; name: string; role: "owner" | "member" }[];
  selectedHouseholdId: string | null;
  selectionUnavailable: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState("");
  async function rename(id: string) {
    setRenaming(true); setError(""); setNotice("");
    try {
      const result = await renameHousehold(id, draft);
      if (!result.ok) { setError(result.error); return; }
      setEditing(null); setNotice("Household renamed."); router.refresh();
    } catch {
      setError("The household could not be renamed. Check your connection and try again.");
    } finally { setRenaming(false); }
  }
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
    {notice ? <Banner>{notice}</Banner> : null}
    {households.map((household) => <div key={household.id} className="space-y-3 rounded-control border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 break-words font-semibold">{household.name}{household.id === selectedHouseholdId ? " (current)" : ""}</p>
        <div className="flex flex-wrap gap-2">
          {household.role === "owner" && editing !== household.id ? <Button variant="secondary" disabled={pending !== null}
            onClick={() => { setEditing(household.id); setDraft(household.name); setError(""); setNotice(""); }}
            aria-label={`Rename household: ${household.name}`}>Rename</Button> : null}
          <Button className="max-w-full whitespace-normal! text-left" disabled={pending !== null} loading={pending === household.id}
            onClick={() => void select(household.id)} aria-label={`Use household: ${household.name}`}>Use this household</Button>
        </div>
      </div>
      {editing === household.id ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void rename(household.id); }}>
        <fieldset disabled={renaming} className="space-y-3">
          <Field label="Household name" htmlFor={`household-name-${household.id}`} hint="Up to 100 characters.">
            <Input id={`household-name-${household.id}`} required maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={renaming} disabled={!draft.trim()}>Save name</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </fieldset>
      </form> : null}
    </div>)}
    {!households.length ? <p>No household memberships are available. Continue household setup from onboarding.</p> : null}
  </section>;
}
