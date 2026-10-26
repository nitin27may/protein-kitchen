"use client";

import { useState } from "react";
import { authRequest } from "@/lib/auth/browser";
import { Banner, Button, Field, Input } from "@/components/ui";

type Method = "code" | "password";

/**
 * Account deletion. An email code to the session's own address is the normal proof, because accounts made by email code
 * have no password. An account that has set a password may use it instead.
 */
export function DeleteAccountControls({ email, hasPassword, onlyMember }: { email: string; hasPassword: boolean; onlyMember: boolean }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>(hasPassword ? "password" : "code");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function close() {
    setOpen(false); setSent(false); setCode(""); setPassword(""); setConfirmation(""); setError(""); setNotice(""); setMethod(hasPassword ? "password" : "code");
  }
  async function run(task: () => Promise<void>) {
    setPending(true); setError(""); setNotice("");
    try { await task(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The request failed. Try again."); }
    finally { setPending(false); }
  }
  async function sendCode() {
    await authRequest("/email-otp/send-verification-otp", { email, type: "email-verification" });
    setSent(true); setCode("");
    setNotice(`We sent a six-digit code to ${email}. The subject reads "Verify your Protein Kitchen email". It expires in five minutes and works once.`);
  }
  const ready = confirmation === "DELETE" && (method === "password" ? password.length > 0 : /^\d{6}$/.test(code));
  return <section className="space-y-3" aria-labelledby="delete-heading">
    <h2 id="delete-heading" className="text-xl font-semibold">Delete your account</h2>
    {onlyMember ? <p className="text-sm text-muted">You are the only member of this household, so deleting your account also deletes the household. That removes your login, your meal profile (including birth date, height and weight), plans, shopping lists, pantry, prep, ratings, favourites, notes, links, saved views, routines, device registrations and photos. It cannot be undone. Copies can remain in database backups for up to 7 days. Download your account first if you want a copy; the download does not include shared plans or photos.</p>
      : <p className="text-sm text-muted">Other people share your household. Deleting your account removes your login, sessions, invitations, device registrations, ratings and favourites. The household stays for them, including your meal profile, until an owner removes it. If you are an owner, make another cook an owner first. Download your account first if you want a copy.</p>}
    {open ? <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        if (method === "code" && !sent) { await sendCode(); return; }
        try {
          await authRequest("/delete-household-account", method === "code" ? { code, confirmation } : { password, confirmation });
          window.location.replace("/account-deleted");
        } finally { setPassword(""); setCode(""); }
      });
    }}>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {notice ? <Banner>{notice}</Banner> : null}
      <fieldset disabled={pending} className="space-y-3">
        {method === "password" ? <Field label="Current password" htmlFor="delete-password">
          <Input id="delete-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field> : sent ? <Field label="Six-digit email code" htmlFor="delete-code">
          <Input id="delete-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
        </Field> : <p className="text-sm">We will email a code to {email} to confirm it is you.</p>}
        {method === "password" || sent ? <Field label="Type DELETE to confirm" htmlFor="delete-confirmation">
          <Input id="delete-confirmation" autoComplete="off" required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </Field> : null}
        <div className="flex flex-wrap gap-2">
          {method === "code" && !sent
            ? <Button type="submit" loading={pending}>Email me a code</Button>
            : <Button variant="danger" type="submit" loading={pending} disabled={!ready}>Permanently delete my account</Button>}
          {method === "code" && sent ? <Button variant="secondary" type="button" onClick={() => void run(sendCode)}>Send a new code</Button> : null}
          <Button variant="secondary" type="button" onClick={close}>Cancel account deletion</Button>
        </div>
        {hasPassword ? <Button variant="ghost" type="button" onClick={() => { setMethod(method === "code" ? "password" : "code"); setError(""); setNotice(""); }}>
          {method === "code" ? "Use my password instead" : "Use an email code instead"}
        </Button> : null}
      </fieldset>
    </form> : <Button variant="danger" onClick={() => setOpen(true)}>Delete my account</Button>}
  </section>;
}
