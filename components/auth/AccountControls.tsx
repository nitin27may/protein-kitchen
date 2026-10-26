"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { addHouseholdEmailAssociation, cancelInvitation, changeCookRole, removeCook, resendHouseholdAssociationNotice } from "@/app/onboarding/actions";
import { authRequest } from "@/lib/auth/browser";
import { Banner, Button, Field, Input, Select } from "@/components/ui";
import { SignOutButton } from "./SignOutButton";
import { EmailAssociationPrompt } from "./EmailAssociationPrompt";

export function AccountControls({ owner, invitations, incomingAssociations, members, currentUserId }: {
  owner: boolean;
  invitations: { id: string; email: string; displayName: string | null; relationship: string | null; canResend: boolean }[];
  incomingAssociations: { id: string }[];
  members: { userId: string; role: "owner" | "member"; name: string; email: string; profileName: string | null }[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ userId: string; role?: "owner" | "member" } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  async function run(task: () => Promise<void>) {
    setPending(true); setError(""); setNotice("");
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : "The request failed. Try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-5">
    {error ? <Banner tone="bad">{error}</Banner> : null}
    {notice ? <Banner>{notice}</Banner> : null}
    <EmailAssociationPrompt associations={incomingAssociations} />
    <SignOutButton disabled={pending} />
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
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Delete your account</h2>
      <p className="text-sm text-muted">Permanently removes your login, sessions, invitations, device registrations, ratings and favourites. Shared plans, shopping, prep, notes and photos remain. Your unlinked meal profile, requirements, preferences, routines and profile history remain for the household's saved meals; this does not erase your meal profile. An owner manages profile deletion separately. Download your account first if you want a copy.</p>
      <p className="text-sm text-muted">The last verified owner with a completed profile cannot delete their account. Make another cook an owner first.</p>
      {deleting ? <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          try {
            await authRequest("/delete-household-account", { password: deletePassword, confirmation: deleteConfirmation });
            window.location.replace("/sign-in");
          } finally { setDeletePassword(""); }
        });
      }}>
        <fieldset disabled={pending} className="space-y-3">
          <Field label="Current password" htmlFor="delete-password">
            <Input id="delete-password" type="password" autoComplete="current-password" required maxLength={128} value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
          </Field>
          <Field label="Type DELETE to confirm" htmlFor="delete-confirmation">
            <Input id="delete-confirmation" autoComplete="off" required value={deleteConfirmation} onChange={(e) => setDeleteConfirmation(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" type="submit" loading={pending} disabled={deleteConfirmation !== "DELETE" || !deletePassword}>Permanently delete my account</Button>
            <Button variant="secondary" type="button" onClick={() => { setDeleting(false); setDeletePassword(""); setDeleteConfirmation(""); }}>Cancel account deletion</Button>
          </div>
        </fieldset>
      </form> : <Button variant="danger" disabled={pending} onClick={() => setDeleting(true)}>Delete my account</Button>}
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
              setConfirmation(null); router.refresh();
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
      <h2 className="text-xl font-semibold">Add a household member by email</h2>
      <p>They can review the association after signing in and verifying this email address. Their profile and household access remain separate until they accept.</p>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const result = await addHouseholdEmailAssociation({
          email, displayName: displayName || undefined, relationship: relationship || undefined,
        });
        if (!result.ok) { setError(result.error); return; }
        setEmail(""); setDisplayName(""); setRelationship("");
        setNotice(result.emailSent ? "Association created and notification email sent." : "Association created, but the notification email could not be sent. Resend it below.");
        router.refresh();
      }); }}>
        <fieldset disabled={pending} className="space-y-4">
          <Field label="Member's email" htmlFor="association-email">
            <Input id="association-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Display name (optional)" htmlFor="association-name">
            <Input id="association-name" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Relationship (optional)" htmlFor="association-relationship" hint="For display only; it does not change permissions.">
            <Select id="association-relationship" value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              <option value="">No label</option>
              <option value="partner">Partner</option>
              <option value="spouse">Spouse</option>
              <option value="roommate">Roommate</option>
              <option value="family">Family member</option>
              <option value="friend">Friend</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Button type="submit" loading={pending}>Add email association</Button>
        </fieldset>
      </form>
      {invitations.length ? <div className="space-y-2">
        <h3 className="font-semibold">Pending household associations</h3>
        {invitations.map((i) => <div key={i.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-all">{i.email}{i.displayName ? ` · ${i.displayName}` : ""}{i.relationship ? ` · ${i.relationship}` : ""}</span>
          <div className="flex flex-wrap gap-2">
          {i.canResend ? <Button variant="secondary" disabled={pending} onClick={() => void run(async () => {
            const result = await resendHouseholdAssociationNotice(i.id);
            if (!result.ok) { setError(result.error); return; }
            setNotice("Notification email sent.");
          })}>Resend notification</Button> : null}
          <Button variant="secondary" disabled={pending} onClick={() => void run(async () => {
            const result = await cancelInvitation(i.id);
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          })}>Revoke</Button>
          </div>
        </div>)}
      </div> : null}
    </section> : null}
  </div>;
}
