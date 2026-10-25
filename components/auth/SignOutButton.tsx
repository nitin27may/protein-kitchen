"use client";

import { useState } from "react";
import { authRequest } from "@/lib/auth/browser";
import { Button } from "@/components/ui";

/** Ends the session, then does a full navigation so no signed-in page state survives. */
export function SignOutButton({ variant = "secondary", className, disabled }: { variant?: "secondary" | "ghost"; className?: string; disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    setPending(true); setFailed(false);
    try {
      await authRequest("/sign-out", {});
      window.location.replace("/sign-in");
    } catch {
      setFailed(true); setPending(false);
    }
  }
  return (
    <>
      <Button variant={variant} className={className} disabled={disabled || pending} onClick={() => void signOut()}>Sign out</Button>
      {failed ? <span role="alert" className="text-sm text-bad">Sign out failed. Try again.</span> : null}
    </>
  );
}
