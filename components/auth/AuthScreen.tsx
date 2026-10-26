"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banner, Button, Field, Input } from "@/components/ui";
import { authRequest, safeAuthReturn } from "@/lib/auth/browser";

type Stage = "password" | "verify" | "code" | "reset" | "link";
const titles: Record<Stage, string> = {
  password: "Sign in with a password", verify: "Verify your email",
  code: "Sign in or create an account", reset: "Reset your password", link: "Sign in or create an account with an email link",
};

/**
 * `embedded` is the sheet version for the signup gate: email then code only, no heading or other sign-in options, and it
 * never navigates itself. `onDone` runs after a verified sign-in so the caller can continue to onboarding.
 */
export function AuthScreen({ initial, next = "/", invite, emailLinkError = false, embedded = false, inviteOnly = false, onDone }: { initial: Stage; next?: string; invite?: string; emailLinkError?: boolean; embedded?: boolean; inviteOnly?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [stage, setStage] = useState(initial);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(initial === "verify");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(emailLinkError ? "This email link is invalid, expired or already used. Request a new link to sign in." : "");
  const [notice, setNotice] = useState("");

  function change(nextStage: Stage, message = "") {
    setStage(nextStage); setPassword(""); setOtp(""); setError(""); setNotice(message);
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
    setNotice("Check your email to continue. Codes expire after five minutes.");
  }
  function signedIn() {
    setPassword(""); setOtp("");
    if (embedded) { onDone?.(); return; }
    router.push(`/onboarding?next=${encodeURIComponent(safeAuthReturn(next))}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`);
    router.refresh();
  }
  async function submit() {
    if (stage === "link") {
      await authRequest("/sign-in/magic-link", {
        email, callbackURL: "/onboarding", newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/sign-in?emailLinkError=1",
      });
      setNotice("Check your email to continue. Open the link in the browser you want to use. It expires in five minutes and can be used once.");
    } else if (stage === "password") {
      await authRequest("/sign-in/email", { email, password }); signedIn();
    } else if (!sent) await sendCode();
    else if (stage === "verify") {
      await authRequest("/email-otp/verify-email", { email, otp });
      change("password", "Email verified. Sign in with your password.");
    } else if (stage === "code") {
      await authRequest("/sign-in/email-otp", { email, otp }); signedIn();
    } else {
      await authRequest("/email-otp/reset-password", { email, otp, password });
      change("password", "Password updated. Previous sessions were signed out. Sign in with your new password.");
    }
  }

  const needsPassword = stage === "password" || (stage === "reset" && sent);
  const needsCode = sent && ["verify", "code", "reset"].includes(stage);
  const label = stage === "link" ? "Email me a link" : stage === "password" ? "Sign in" :
    !sent ? "Email me a code" : stage === "verify" ? "Verify email" : stage === "code" ? "Continue" : "Update password";
  return (
    <section className={embedded ? "space-y-4 p-4" : "mx-auto max-w-lg space-y-5 px-4 pb-28 pt-8"}>
      {embedded ? null : <h1 className="text-2xl font-bold">{titles[stage]}</h1>}
      <p className="text-muted">{embedded ? "Enter your email and we will send you a six-digit code. New here? It creates your account and your kitchen, and your work on this device comes with you." : stage === "code" || stage === "link" ? `Enter your email and we will send you a ${stage === "code" ? "six-digit code" : "sign-in link"}. New here? It also creates your account and your kitchen.` : "Separate accounts, one shared meal plan and shopping list. Your meal profile keeps your own targets."}</p>
      {inviteOnly && !embedded ? <p className="text-sm text-muted">Sign-up is invite-only for now.</p> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {notice ? <Banner>{notice}</Banner> : null}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(submit); }}>
        <fieldset disabled={pending} className="space-y-4">
          <Field label="Email" htmlFor="account-email">
            <Input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email}
              onChange={(e) => { setEmail(e.target.value); setOtp(""); }} />
          </Field>
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
      {embedded ? <a href="/sign-in" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-2 hover:underline">I have a password</a> : null}
      {embedded ? null : <nav aria-label="Account options" className="flex flex-col items-start">
        {stage === "password" ? <>
          <Button variant="ghost" disabled={pending} onClick={() => change("code")}>Use an email code instead</Button>
          <Button variant="ghost" disabled={pending} onClick={() => change("reset")}>Forgot password?</Button>
          <Button variant="ghost" disabled={pending} onClick={() => change("verify")}>Verify an existing account</Button>
        </> : <>
          {stage !== "code" ? <Button variant="ghost" disabled={pending} onClick={() => change("code")}>Use an email code</Button> : null}
          {stage !== "link" ? <Button variant="ghost" disabled={pending} onClick={() => change("link")}>Email me a link instead</Button> : null}
          <Button variant="ghost" disabled={pending} onClick={() => change("password")}>I have a password</Button>
        </>}
        <p className="mt-2 text-sm text-muted">After a reload, enter your email again to resume. Codes are not saved in this browser.</p>
      </nav>}
    </section>
  );
}
