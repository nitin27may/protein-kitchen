"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banner, Button, Field, Input, Segmented } from "@/components/ui";
import { authRequest, safeAuthReturn } from "@/lib/auth/browser";

type Stage = "password" | "sign-up" | "verify" | "code" | "reset" | "link";
const titles: Record<Stage, string> = {
  password: "Sign in", "sign-up": "Join your household", verify: "Verify your email",
  code: "Sign in with a code", reset: "Reset your password", link: "Sign in with an email link",
};

export function AuthScreen({ initial, next = "/", emailLinkError = false }: { initial: Stage; next?: string; emailLinkError?: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState(initial);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [grant, setGrant] = useState("");
  const [kind, setKind] = useState<"invitation" | "bootstrap">("invitation");
  const [sent, setSent] = useState(initial === "verify");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(emailLinkError ? "This email link is invalid, expired or already used. Request a new link to sign in." : "");
  const [notice, setNotice] = useState("");

  function change(nextStage: Stage, message = "") {
    setStage(nextStage); setPassword(""); setOtp(""); setGrant(""); setError(""); setNotice(message);
    setSent(nextStage === "verify");
  }
  async function run(task: () => Promise<void>) {
    setPending(true); setError(""); setNotice("");
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : "The request failed. Please try again."); }
    finally { setPending(false); }
  }
  async function sendCode() {
    if (stage === "reset") await authRequest("/email-otp/request-password-reset", { email });
    else await authRequest("/email-otp/send-verification-otp", {
      email, type: stage === "verify" ? "email-verification" : "sign-in",
    });
    setSent(true);
    setNotice("If this account can receive a code, it has been sent. Check your inbox. Codes expire after five minutes.");
  }
  function signedIn() {
    setPassword(""); setOtp("");
    router.push(`/onboarding?next=${encodeURIComponent(safeAuthReturn(next))}`);
    router.refresh();
  }
  async function submit() {
    if (stage === "link") {
      await authRequest("/sign-in/magic-link", {
        email, callbackURL: "/onboarding", newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/sign-in?emailLinkError=1",
      });
      setNotice("If this account can sign in, an email link has been sent. Open it in the browser you want to sign in to. It expires in five minutes and can be used once.");
    } else if (stage === "sign-up") {
      await authRequest("/sign-up/email", { name, email, password }, {
        [kind === "bootstrap" ? "x-household-bootstrap" : "x-household-invitation"]: grant,
      });
      change("verify", "Check your inbox for a six-digit code. Keep your household key or invitation for onboarding.");
    } else if (stage === "password") {
      await authRequest("/sign-in/email", { email, password }); signedIn();
    } else if (!sent) await sendCode();
    else if (stage === "verify") {
      await authRequest("/email-otp/verify-email", { email, otp });
      change("password", "Email verified. Sign in to finish joining your household.");
    } else if (stage === "code") {
      await authRequest("/sign-in/email-otp", { email, otp }); signedIn();
    } else {
      await authRequest("/email-otp/reset-password", { email, otp, password });
      change("password", "Password updated. Previous sessions were signed out. Sign in with your new password.");
    }
  }

  const needsPassword = stage === "password" || stage === "sign-up" || (stage === "reset" && sent);
  const needsCode = sent && ["verify", "code", "reset"].includes(stage);
  const label = stage === "link" ? "Send email link" : stage === "sign-up" ? "Create account" : stage === "password" ? "Sign in" :
    !sent ? "Send code" : stage === "verify" ? "Verify email" : stage === "code" ? "Sign in with code" : "Update password";
  return (
    <section className="mx-auto max-w-lg space-y-5 px-4 pb-28 pt-8">
      <h1 className="text-2xl font-bold">{titles[stage]}</h1>
      <p className="text-muted">Separate accounts, one shared meal plan and shopping list. Your meal profile keeps your own targets.</p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {notice ? <Banner>{notice}</Banner> : null}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(submit); }}>
        <fieldset disabled={pending} className="space-y-4">
          {stage === "sign-up" ? <Field label="Account name" htmlFor="account-name">
            <Input id="account-name" autoComplete="name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </Field> : null}
          <Field label="Email" htmlFor="account-email">
            <Input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email}
              onChange={(e) => { setEmail(e.target.value); setOtp(""); }} />
          </Field>
          {stage === "sign-up" ? <>
            <Segmented label="How are you joining?" value={kind} onChange={setKind}
              options={[{ value: "invitation", label: "Invited cook" }, { value: "bootstrap", label: "First owner" }]} />
            <Field label={kind === "bootstrap" ? "Household bootstrap key" : "Invitation code"} htmlFor="admission">
              <Input id="admission" type="password" autoComplete="off" required maxLength={256} value={grant} onChange={(e) => setGrant(e.target.value)} />
            </Field>
          </> : null}
          {needsCode ? <Field label="Six-digit email code" htmlFor="email-code">
            <Input id="email-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value)} />
          </Field> : null}
          {needsPassword ? <Field label={stage === "reset" ? "New password" : "Password"} htmlFor="account-password"
            hint={stage === "password" ? undefined : "Use 12 to 128 characters."}>
            <Input id="account-password" type="password" autoComplete={stage === "password" ? "current-password" : "new-password"}
              required minLength={stage === "password" ? 1 : 12} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field> : null}
          <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Please wait" : label}</Button>
        </fieldset>
      </form>
      {needsCode ? <Button variant="secondary" className="w-full" disabled={pending || !email}
        onClick={() => void run(sendCode)}>Send a new code</Button> : null}
      <nav aria-label="Account options" className="flex flex-col items-start">
        {stage !== "password" ? <Button variant="ghost" disabled={pending} onClick={() => change("password")}>Use a password</Button> : <>
          <Button variant="ghost" disabled={pending} onClick={() => change("link")}>Use an email link</Button>
          <Button variant="ghost" disabled={pending} onClick={() => change("code")}>Use an email code</Button>
          <Button variant="ghost" disabled={pending} onClick={() => change("reset")}>Forgot password?</Button>
          <Button variant="ghost" disabled={pending} onClick={() => change("verify")}>Verify an existing account</Button>
        </>}
        <Link href="/sign-up" className="inline-flex min-h-11 items-center px-4 text-primary">Have an invitation? Create an account</Link>
        <p className="mt-2 text-sm text-muted">After a reload, enter your email again to resume. Codes and household keys are not saved in this browser.</p>
      </nav>
    </section>
  );
}
