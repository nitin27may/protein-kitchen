"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AuthScreen } from "@/components/auth/AuthScreen";
import { Sheet } from "@/components/Sheet";
import { beginSignup, type GateIntent } from "@/lib/auth/signup-gate";
import { safeAuthReturn } from "@/lib/auth/browser";
import { browserStores } from "@/lib/plan/anon-draft";

/**
 * The signup gate. A control that saves something stays visible for everyone. For a signed-in person it runs the server
 * action as before. For a visitor it calls `require(...)`, which records what they were doing, copies their draft for
 * signup, and opens an email-then-code sheet. After the code is verified the person continues to onboarding, and
 * `PendingIntentReplay` finishes the action. This is a convenience only: every server action checks the session itself.
 */

export interface RequireOptions {
  intent: GateIntent;
  /** Defaults to the page the person is on. */
  returnTo?: string;
}

interface GateValue {
  /** True for a visitor without an account. */
  anonymous: boolean;
  /** Opens the signup sheet. Returns false when the person is signed in, so the caller should run its action. */
  require: (options: RequireOptions) => boolean;
}

const Ctx = createContext<GateValue>({ anonymous: false, require: () => false });

export function useRequireAccount(): GateValue {
  return useContext(Ctx);
}

export function RequireAccountProvider({ anonymous, children }: { anonymous: boolean; children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<{ open: boolean; returnTo: string }>({ open: false, returnTo: "/" });

  const require = useCallback((options: RequireOptions) => {
    if (!anonymous) return false;
    const returnTo = safeAuthReturn(options.returnTo ?? `${window.location.pathname}${window.location.search}`);
    beginSignup(browserStores(), { intent: options.intent, returnTo }, new Date());
    setState({ open: true, returnTo });
    return true;
  }, [anonymous]);

  const value = useMemo(() => ({ anonymous, require }), [anonymous, require]);

  function done() {
    const target = state.returnTo;
    setState((s) => ({ ...s, open: false }));
    router.push(`/onboarding?next=${encodeURIComponent(target)}`);
    router.refresh();
  }

  return (
    <Ctx.Provider value={value}>
      {children}
      {anonymous ? (
        <Sheet open={state.open} onClose={() => setState((s) => ({ ...s, open: false }))} title="Create your account to continue">
          <AuthScreen initial="code" embedded next={state.returnTo} onDone={done} />
        </Sheet>
      ) : null}
    </Ctx.Provider>
  );
}
