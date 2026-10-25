"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changeAccountPassword, setAccountPassword } from "@/app/account/actions";
import { Banner, Button, Field, Input } from "@/components/ui";

const MIN = 12;
const MAX = 128;

export function PasswordControls({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState("");

  function reset() { setCurrent(""); setNext(""); setConfirm(""); setFields({}); }
  async function submit() {
    setError(""); setDone(""); setFields({});
    if (next.length < MIN || next.length > MAX) { setFields({ newPassword: `Use ${MIN} to ${MAX} characters.` }); return; }
    if (next !== confirm) { setFields({ confirm: "The passwords do not match." }); return; }
    setPending(true);
    try {
      const result = hasPassword
        ? await changeAccountPassword({ currentPassword: current, newPassword: next })
        : await setAccountPassword({ newPassword: next });
      if (!result.ok) { setError(result.error); setFields(result.fields ?? {}); return; }
      reset(); setOpen(false);
      setDone(hasPassword ? "Password changed. Your other devices were signed out." : "Password set. You can now sign in with it. Your other devices were signed out.");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally { setPending(false); }
  }
  const title = hasPassword ? "Change password" : "Set a password";
  return <section className="space-y-3" aria-labelledby="password-heading">
    <h2 id="password-heading" className="text-xl font-semibold">Password</h2>
    <p className="text-sm text-muted">{hasPassword
      ? "You can sign in with your email and password, or with an email code."
      : "Optional. You can always sign in with an email code; a password adds another way in."}</p>
    {done ? <Banner>{done}</Banner> : null}
    {open ? <form className="space-y-3" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <fieldset disabled={pending} className="space-y-3">
        {hasPassword ? <Field label="Current password" htmlFor="current-password" error={fields.currentPassword}>
          <Input id="current-password" type="password" autoComplete="current-password" required maxLength={MAX}
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field> : null}
        <Field label="New password" htmlFor="new-password" hint={`Use ${MIN} to ${MAX} characters.`} error={fields.newPassword}>
          <Input id="new-password" type="password" autoComplete="new-password" required minLength={MIN} maxLength={MAX}
            value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password" error={fields.confirm}>
          <Input id="confirm-password" type="password" autoComplete="new-password" required maxLength={MAX}
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={pending}>{hasPassword ? "Save new password" : "Save password"}</Button>
          <Button type="button" variant="secondary" onClick={() => { setOpen(false); reset(); setError(""); }}>Cancel</Button>
        </div>
      </fieldset>
    </form> : <Button variant="secondary" onClick={() => { setOpen(true); setDone(""); }}>{title}</Button>}
  </section>;
}
