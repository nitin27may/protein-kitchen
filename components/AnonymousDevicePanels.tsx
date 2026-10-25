"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRequireAccount } from "@/components/auth/RequireAccount";
import { GroceryClient } from "@/components/GroceryClient";
import { AnonymousPrompt } from "@/components/AnonymousPrompt";
import { Banner, Button, Card, LinkButton, PageTitle } from "@/components/ui";
import { browserStores, anonProteinTargetG, loadAnonDraft, loadAnonProfile, type AnonDraft, type AnonProfile } from "@/lib/plan/anon-draft";
import { deviceGroceryLines } from "@/lib/plan/anon-groceries";
import { useAnonLibrary } from "@/lib/library/use-anon-library";
import { formatDay } from "@/lib/planner/dates";

/** Reads the device draft and profile after hydration. `ready` is false until storage has been looked at. */
function useDeviceCopy() {
  const [state, setState] = useState<{ ready: boolean; draft: AnonDraft | null; profile: AnonProfile | null }>({ ready: false, draft: null, profile: null });
  useEffect(() => {
    const stores = browserStores();
    const now = new Date();
    const loaded = loadAnonDraft(stores, { now });
    setState({ ready: true, draft: loaded.status === "ok" || loaded.status === "library-mismatch" ? loaded.draft : null, profile: loadAnonProfile(stores, now) });
  }, []);
  return state;
}

const range = (d: AnonDraft) => `${formatDay(d.setup.startDate).long} to ${formatDay(d.setup.endDate).long}`;

/** /plan for a visitor: their device plan when there is one, otherwise the invitation to make one. */
export function AnonymousPlan(props: { title: string; sub?: string; heading: string; body: string }) {
  const { ready, draft } = useDeviceCopy();
  if (!ready || !draft) return <AnonymousPrompt {...props} />;
  return (
    <>
      <PageTitle title={props.title} sub={props.sub} />
      <div className="px-4 pb-6">
        <Card className="space-y-3" >
          <h2 className="text-lg font-semibold">Your plan is on this device</h2>
          <p className="text-muted">{range(draft)}, {draft.slots.length} meals. It is not saved to an account yet.</p>
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/plan/draft" size="lg">Open plan</LinkButton>
            <LinkButton href="/plan/new" variant="secondary" size="lg">Make a new plan</LinkButton>
          </div>
        </Card>
      </div>
    </>
  );
}

/** /groceries for a visitor: the list for the device plan with device-only ticking, or the prompt. */
export function AnonymousGroceries(props: { title: string; heading: string; body: string }) {
  const { ready, draft } = useDeviceCopy();
  const library = useAnonLibrary();
  const list = useMemo(() => {
    if (!draft || library.status !== "ready") return null;
    try { return deviceGroceryLines(draft, library.library); } catch { return "error" as const; }
  }, [draft, library]);
  if (!ready || !draft) return <AnonymousPrompt {...props} />;
  return (
    <>
      <PageTitle title={props.title} sub="Amounts are rounded up so you do not run short." />
      {library.status === "error" ? <div className="px-4"><Banner tone="bad" title="The recipe library did not load"><p>{library.message}</p><Button variant="secondary" size="sm" className="mt-2" onClick={library.retry}>Try again</Button></Banner></div> : null}
      {list === "error" ? <div className="px-4"><Banner tone="bad">The list could not be built for this plan. Make the plan again.</Banner></div> : null}
      {list && list !== "error" ? (
        <GroceryClient anonymous planId={0} rangeLabel={range(draft)} weeks={[]} lines={list.lines} singleUse={list.singleUse} manual={[]} />
      ) : library.status === "loading" ? <p className="px-4 text-muted" role="status">Building your list...</p> : null}
    </>
  );
}

/** /profiles for a visitor: the device profile with a way to keep it, or the prompt. */
export function AnonymousProfiles(props: { title: string; sub?: string; heading: string; body: string }) {
  const { ready, profile } = useDeviceCopy();
  const gate = useRequireAccount();
  if (!ready || !profile) return <AnonymousPrompt {...props} />;
  const target = anonProteinTargetG(profile);
  const actions: ReactNode = (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => gate.require({ intent: { kind: "save-profile" }, returnTo: "/profiles" })}>Save my profile</Button>
      <LinkButton href="/plan/new?step=who" variant="secondary">Edit</LinkButton>
    </div>
  );
  return (
    <>
      <PageTitle title={props.title} sub={props.sub} />
      <div className="px-4 pb-6">
        <Card className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primarysoft font-display text-xl font-bold text-primary" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase()}</span>
            <div className="min-w-0"><h2 className="truncate text-lg font-semibold">{profile.name}</h2><p className="text-sm text-muted">On this device only</p></div>
          </div>
          <dl className="grid grid-cols-2 gap-2 border-t border-line pt-3">
            <div><dt className="text-sm text-muted">Protein a day</dt><dd className="font-display text-2xl font-bold tabular-nums">{target} g</dd></div>
            <div><dt className="text-sm text-muted">Calories</dt><dd className="font-display text-2xl font-bold tabular-nums">{profile.kcalTarget ?? "--"}</dd></div>
          </dl>
          <p className="text-sm text-muted">Create an account to keep this profile, add other people and set a prep reminder.</p>
          {actions}
        </Card>
      </div>
    </>
  );
}
