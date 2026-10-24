"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelInvitation, inviteCook } from "@/app/onboarding/actions";
import { authRequest } from "@/lib/auth/browser";
import { Banner, Button, Field, Input, Select } from "@/components/ui";

export function AccountControls({ owner, profiles, invitations }: {
  owner: boolean; profiles: { id: number; name: string }[];
  invitations: { id: string; email: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [person, setPerson] = useState("");
  const [token, setToken] = useState("");
  const [tokenEmail, setTokenEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function run(task: () => Promise<void>) {
    setPending(true); setError("");
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : "The request failed. Try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-5">
    {error ? <Banner tone="bad">{error}</Banner> : null}
    <Button variant="secondary" disabled={pending} onClick={() => void run(async () => {
      await authRequest("/sign-out", {});
      setToken(""); router.replace("/sign-in"); router.refresh();
    })}>Sign out</Button>
    {owner ? <section className="space-y-4">
      <h2 className="text-xl font-semibold">Invite another cook</h2>
      <p>They get their own login and targets, and use this household's existing plans, shopping list and prep.</p>
      <p className="text-sm text-muted">No invitation email is sent yet. Share the one-time code privately with the named recipient. It expires in seven days.</p>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const result = await inviteCook(email, person ? Number(person) : undefined);
        if (!result.ok) { setError(result.error); return; }
        setToken(result.token); setTokenEmail(result.email); router.refresh();
      }); }}>
        <fieldset disabled={pending} className="space-y-4">
          <Field label="Cook's email" htmlFor="invite-email">
            <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Reserve an existing profile (optional)" htmlFor="invite-profile">
            <Select id="invite-profile" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">They will create their own profile</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Button type="submit" loading={pending}>Create invitation code</Button>
        </fieldset>
      </form>
      {token ? <Banner title={`Invitation for ${tokenEmail}`}>
        <p>Copy this code now. It cannot be read back from the database.</p>
        <code data-testid="invitation-code" className="mt-2 block break-all select-all">{token}</code>
        <Button variant="secondary" onClick={() => setToken("")}>Hide code</Button>
      </Banner> : null}
      {invitations.length ? <div className="space-y-2">
        <h3 className="font-semibold">Pending invitations</h3>
        {invitations.map((i) => <div key={i.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="break-all">{i.email}</span>
          <Button variant="secondary" disabled={pending} onClick={() => void run(async () => {
            const result = await cancelInvitation(i.id);
            if (!result.ok) { setError(result.error); return; }
            setToken(""); router.refresh();
          })}>Revoke invitation</Button>
        </div>)}
      </div> : null}
    </section> : null}
  </div>;
}
