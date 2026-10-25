"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { joinHousehold, linkOwnProfile } from "@/app/onboarding/actions";
import { Banner, Button, Field, Input, Segmented, Select } from "@/components/ui";

export function HouseholdEntry({ profiles }: { profiles?: { id: number; name: string }[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<"bootstrap" | "invitation">("invitation");
  const [grant, setGrant] = useState("");
  const [person, setPerson] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setPending(true); setError("");
      try {
        const result = profiles ? await linkOwnProfile(Number(person)) : await joinHousehold(kind, grant);
        if (!result.ok) { setError(result.error); return; }
        setGrant(""); router.refresh();
      } catch { setError("Could not finish household setup. Please try again."); }
      finally { setPending(false); }
    }}>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <fieldset disabled={pending} className="space-y-4">
        {profiles ? <Field label="Existing meal profile" htmlFor="existing-profile">
          <Select id="existing-profile" value={person} onChange={(e) => setPerson(e.target.value)} required>
            <option value="">Choose your profile</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field> : <>
          <Segmented label="How are you joining?" value={kind} onChange={setKind}
            options={[{ value: "invitation", label: "Invited cook" }, { value: "bootstrap", label: "First owner" }]} />
          <Field label={kind === "bootstrap" ? "Household bootstrap key" : "Invitation code"} htmlFor="join-grant">
            <Input id="join-grant" type="password" required autoComplete="off" maxLength={256} value={grant} onChange={(e) => setGrant(e.target.value)} />
          </Field>
        </>}
        <Button type="submit" size="lg" loading={pending}>{profiles ? "Link my profile" : "Join household"}</Button>
      </fieldset>
    </form>
  );
}
