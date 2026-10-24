"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelInvitation, changeCookRole, inviteCook, removeCook } from "@/app/onboarding/actions";
import { authRequest } from "@/lib/auth/browser";
import { Banner, Button, Field, Input, Select } from "@/components/ui";

export function AccountControls({ owner, profiles, invitations, members, currentUserId }: {
  owner: boolean; profiles: { id: number; name: string }[];
  invitations: { id: string; email: string }[];
  members: { userId: string; role: "owner" | "member"; name: string; email: string; profileName: string | null }[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [person, setPerson] = useState("");
  const [token, setToken] = useState("");
  const [tokenEmail, setTokenEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ userId: string; role?: "owner" | "member" } | null>(null);
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
      setToken(""); window.location.replace("/sign-in");
    })}>Sign out</Button>
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Download your account</h2>
      <p className="text-sm text-muted">Includes your account details, private meal profile, preferences, routines, ratings and favourites. Keep the file private. This is not a backup of the household's shared plans or photos.</p>
      <Button variant="secondary" loading={pending} onClick={() => void run(async () => {
        const response = await fetch("/api/account/export", { cache: "no-store" }).catch(() => {
          throw new Error("Your account download failed. Check your connection and try again.");
        });
        if (!response.ok) throw new Error("Your account could not be downloaded. Try again, or sign in again if your session has expired.");
        if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("The server did not return an account file. Try again.");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        try {
          link.href = url; link.download = "protein-kitchen-account.json";
          document.body.append(link); link.click();
        } finally {
          link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      })}>Download my account</Button>
    </section>
    {owner ? <section className="space-y-4">
      <h2 className="text-xl font-semibold">Household cooks</h2>
      <p className="text-sm text-muted">Owners manage access and private profiles. Removing a cook signs them out but keeps their meal profile and the household's shared plans, shopping and prep.</p>
      {members.map((member) => <fieldset key={member.userId} aria-label={`Cook ${member.name}`} disabled={pending} className="space-y-3 rounded-control border border-line p-4">
        <legend className="px-1 font-semibold">{member.name}{member.userId === currentUserId ? " (you)" : ""}</legend>
        <p className="break-all text-sm">{member.email}</p>
        <p className="text-sm"><span className="capitalize">{member.role}</span>{member.profileName ? ` · ${member.profileName}` : " · Profile onboarding incomplete"}</p>
        {confirmation?.userId === member.userId ? <div className="space-y-3">
          <p className="text-sm">{confirmation.role
            ? `Make ${member.name} ${confirmation.role === "owner" ? "an owner" : "a member"}? Demotion also revokes their pending invitations.`
            : `Remove ${member.name}'s household access and sign out all their devices? Their profile and shared data will remain.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant={confirmation.role ? "primary" : "danger"} loading={pending} onClick={() => void run(async () => {
              const result = confirmation.role ? await changeCookRole(member.userId, confirmation.role) : await removeCook(member.userId);
              if (!result.ok) { setError(result.error); return; }
              setConfirmation(null); setToken(""); router.refresh();
            })}>{confirmation.role ? "Confirm role change" : "Confirm removal"}</Button>
            <Button variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
          </div>
        </div> : <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setConfirmation({ userId: member.userId, role: member.role === "owner" ? "member" : "owner" })}>
            {member.role === "owner" ? "Make member" : "Make owner"}
          </Button>
          <Button variant="danger" onClick={() => setConfirmation({ userId: member.userId })}>Remove cook</Button>
        </div>}
      </fieldset>)}
    </section> : null}
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
