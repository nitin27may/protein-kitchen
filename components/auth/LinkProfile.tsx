"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { linkOwnProfile } from "@/app/onboarding/actions";
import { Banner, Button, Field, Select } from "@/components/ui";

export function LinkProfile({ profiles }: { profiles: { id: number; name: string }[] }) {
  const router = useRouter();
  const [person, setPerson] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setPending(true); setError("");
      try {
        const result = await linkOwnProfile(Number(person));
        if (!result.ok) { setError(result.error); return; }
        router.refresh();
      } catch { setError("Could not link the profile. Please try again."); }
      finally { setPending(false); }
    }}>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Existing meal profile" htmlFor="existing-profile">
          <Select id="existing-profile" value={person} onChange={(e) => setPerson(e.target.value)} required>
            <option value="">Choose your profile</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Button type="submit" size="lg" loading={pending}>Link my profile</Button>
      </fieldset>
    </form>
  );
}
