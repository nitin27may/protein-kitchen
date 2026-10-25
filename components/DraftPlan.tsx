"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { importAnonymousDraft } from "@/app/actions";
import { useRequireAccount } from "@/components/auth/RequireAccount";
import { PlanClient } from "@/components/PlanClient";
import type { DraftBindings, PlanSlotView } from "@/components/PlanClient";
import { Banner, Button, Card, EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { aisleLabel, grams } from "@/lib/format";
import {
  anonProteinTargetG, browserStores, clearAllAnonState, type AnonDraft, type AnonProfile,
} from "@/lib/plan/anon-draft";
import { draftDays, draftSwapOptions, enableDraftShake, regenerateDraft, setDraftPortion, swapDraftSlot, toggleDraftLock, type DraftEdit } from "@/lib/plan/anon-edit";
import { deviceGroceryLines } from "@/lib/plan/anon-groceries";
import type { AnonLibrary } from "@/lib/plan/anon-library";
import { draftScreen } from "@/lib/plan/draft-state";
import { useDeviceDraft } from "@/lib/plan/use-device-draft";
import { datesBetween, formatDay } from "@/lib/planner/dates";
import type { ServingUnit } from "@/lib/schemas";

type Serving = Record<string, { servingG: number; unit: ServingUnit | null }>;

const STORAGE_REFUSED = "This browser would not keep your change. Allow site storage or leave private browsing, then try again.";

export function DraftPlan({ libraryVersion, serving, today }: { libraryVersion: string; serving: Serving; today: string }) {
  const { load, profile, library, commit, discard } = useDeviceDraft(libraryVersion);
  const lib = library.status === "ready" ? library.library : null;
  const screen = draftScreen(load, profile, lib);

  if (screen?.kind === "plan" && profile && lib) {
    return <DraftPlanView draft={screen.draft} warning={screen.warning} profile={profile} library={lib} serving={serving} today={today} commit={commit} discard={discard} />;
  }
  if (screen?.kind === "message") {
    return (
      <>
        <PageTitle title="Your plan" />
        <div data-testid="draft-state" data-state={load.status}>
          <EmptyState
            title={screen.title}
            body={screen.body}
            action={<div className="flex flex-wrap justify-center gap-2"><LinkButton href="/plan/new">{load.status === "none" ? "Make a plan" : "Make a new plan"}</LinkButton><LinkButton href="/recipes" variant="secondary">Browse recipes</LinkButton></div>}
          />
        </div>
      </>
    );
  }
  if (library.status === "error" && load.status !== "loading" && load.status !== "none") {
    return (
      <>
        <PageTitle title="Your plan" />
        <div className="px-4"><Banner tone="bad" title="The recipe library did not load"><p>{library.message}</p><Button variant="secondary" size="sm" className="mt-2" onClick={library.retry}>Try again</Button></Banner></div>
      </>
    );
  }
  return (
    <>
      <PageTitle title="Your plan" />
      <p className="px-4 text-muted" role="status">Loading your plan from this device...</p>
    </>
  );
}

function DraftPlanView({ draft, warning, profile, library, serving, today, commit, discard }: {
  draft: AnonDraft; warning: string | null; profile: AnonProfile; library: AnonLibrary; serving: Serving; today: string;
  commit: (draft: AnonDraft) => boolean; discard: () => void;
}) {
  const router = useRouter();
  const gate = useRequireAccount();
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, startSave] = useTransition();

  const { planned, days } = useMemo(() => {
    const d = draftDays(draft, profile, library);
    return { planned: d.slots, days: d.days };
  }, [draft, profile, library]);
  const byslug = useMemo(() => new Map(library.candidates.map((c) => [c.slug, c])), [library]);

  const slots: PlanSlotView[] = planned.map((s, i) => {
    const c = byslug.get(s.recipeSlug);
    const info = serving[s.recipeSlug];
    return {
      id: i, date: s.date, slot: s.slot, recipeSlug: s.recipeSlug, recipeName: c?.name ?? s.recipeSlug,
      proteinG: c?.perServing.protein_g ?? 0, kcal: c?.perServing.kcal ?? 0, activeMin: c?.activeMin ?? 0, locked: s.locked,
      servings: s.servings, image: null, thumbs: [], dense: c?.nutrientDense ?? false, lowSugar: c?.lowSugar ?? false,
      light: c?.light ?? false, leftover: s.isLeftover ?? false, servingG: info?.servingG ?? 0, unit: info?.unit ?? null,
    };
  });
  const dates = datesBetween(draft.setup.startDate, draft.setup.endDate);
  const ref = (slot: PlanSlotView) => ({ date: slot.date, slot: slot.slot });
  const apply = (edit: DraftEdit) => {
    if (!edit.ok) return { ok: false, error: edit.error };
    return commit(edit.draft) ? { ok: true } : { ok: false, error: STORAGE_REFUSED };
  };
  const seed = () => Math.floor(Math.random() * 2 ** 31);

  function savePlan() {
    setNote(null);
    // A visitor is asked for an email and the plan is carried through; a signed-in person saves it straight away.
    if (gate.require({ intent: { kind: "save-plan" }, returnTo: "/plan/draft" })) return;
    startSave(async () => {
      const r = await importAnonymousDraft(draft);
      if (!r.ok) { setNote({ tone: "bad", text: r.error }); return; }
      clearAllAnonState(browserStores());
      router.push(`/plan/${r.planId}`);
    });
  }
  const needAccount = () => gate.require({ intent: { kind: "save-plan" }, returnTo: "/plan/draft" });

  const bindings: DraftBindings = {
    swapOptions: (slot) => draftSwapOptions(draft, profile, library, ref(slot)),
    swap: (slot, recipe) => apply(swapDraftSlot(draft, profile, library, ref(slot), recipe)),
    lock: (slot, locked) => apply(toggleDraftLock(draft, ref(slot), locked)),
    portion: (slot, _person, servings) => apply(setDraftPortion(draft, ref(slot), servings)),
    addShake: () => apply(enableDraftShake(draft, profile, library, seed(), new Date())),
    banner: (
      <div className="space-y-3" data-testid="device-banner">
        <Banner tone="warn" title="This plan is on this device only">
          <p>It is not saved to an account yet. Save it to keep it, share the shopping list and open the prep guide.</p>
          <Button className="mt-2" size="lg" onClick={savePlan} loading={saving}>Save plan</Button>
        </Banner>
        {warning ? <Banner tone="info">{warning}</Banner> : null}
        {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      </div>
    ),
    actions: (
      <Card className="space-y-3">
        <h2 className="text-base font-semibold">This plan</h2>
        <Button size="lg" className="w-full" onClick={savePlan} loading={saving}>Save plan</Button>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <LinkButton href="/groceries" variant="secondary" className="sm:col-span-2 lg:col-span-1 xl:col-span-2">Open grocery list</LinkButton>
          <Button variant="secondary" className="sm:col-span-2 lg:col-span-1 xl:col-span-2" onClick={needAccount}>Meal prep guide</Button>
          <Button variant="secondary" onClick={needAccount}>Export PDF</Button>
          <Button variant="secondary" onClick={needAccount}>Export spreadsheet</Button>
          <Button variant="secondary" onClick={() => { const r = apply(regenerateDraft(draft, profile, library, seed(), new Date())); setNote(r.ok ? { tone: "ok", text: "New plan made. Locked meals were kept." } : { tone: "bad", text: r.error ?? "Something went wrong" }); }}>Regenerate</Button>
          <LinkButton href="/plan/new" variant="secondary">New plan</LinkButton>
        </div>
        <p className="text-sm text-muted">Prep guide and exports need an account. Saving carries this plan with you.</p>
        <div className="border-t border-line pt-3">
          {confirmDiscard ? (
            <div className="space-y-2" role="alertdialog" aria-label="Confirm discard draft">
              <p className="text-sm font-semibold text-bad">Discard this plan from this device? It cannot be undone.</p>
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => { discard(); setConfirmDiscard(false); }}>Discard plan</Button>
                <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep it</Button>
              </div>
            </div>
          ) : <Button variant="danger" size="sm" onClick={() => setConfirmDiscard(true)}>Discard plan</Button>}
        </div>
      </Card>
    ),
  };

  return (
    <>
      <PlanClient
        draft={bindings}
        planId={0}
        startIndex={Math.max(0, dates.indexOf(today))}
        dates={dates.map((iso) => ({ iso, ...formatDay(iso), dayNum: iso.slice(8) }))}
        mealTypes={draft.setup.mealTypes}
        people={[{ id: 1, name: profile.name, target: anonProteinTargetG(profile) }]}
        days={days.map((d) => ({ date: d.date, personId: 1, proteinG: d.proteinG, kcal: d.kcal }))}
        slots={slots}
        makeAheadWeekMin={0}
        allRecipes={library.candidates.map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, activeMin: c.activeMin, slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots] })).sort((a, b) => a.name.localeCompare(b.name))}
      />
      <BuyList draft={draft} library={library} />
    </>
  );
}

function BuyList({ draft, library }: { draft: AnonDraft; library: AnonLibrary }) {
  const list = useMemo(() => {
    try { return deviceGroceryLines(draft, library); } catch { return null; }
  }, [draft, library]);
  if (!list) return <div className="px-4 pb-8"><Banner tone="bad">The shopping list could not be built for this plan. Regenerate the plan to fix it.</Banner></div>;
  const groups = new Map<string, typeof list.lines>();
  for (const l of list.lines.filter((x) => !x.pantry)) groups.set(l.aisle, [...(groups.get(l.aisle) ?? []), l]);
  const sorted = [...groups.entries()].sort((a, b) => aisleLabel(a[0]).localeCompare(aisleLabel(b[0])));
  return (
    <section id="buy" aria-labelledby="buy-h" className="px-4 pb-10 pt-2 lg:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="buy-h" className="text-xl font-bold">What to buy</h2>
        <Link href="/groceries" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary">Tick items off</Link>
      </div>
      <p className="mb-3 text-sm text-muted">For the whole plan, rounded up so you do not run short. Pantry staples are on the full list.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map(([aisle, lines]) => (
          <div key={aisle}>
            <h3 className="mb-1.5 text-base font-semibold">{aisleLabel(aisle)}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
              {lines.map((l) => (
                <li key={l.slug} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">{l.name}{l.state === "dry" ? <span className="text-sm text-muted"> (dry)</span> : null}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{l.packs ? `${l.packs} pack${l.packs > 1 ? "s" : ""}` : grams(l.buyG)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
