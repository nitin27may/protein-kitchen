"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { createPlan } from "@/app/actions";
import { Banner, Button, SectionCard, Stepper, StickyActionBar } from "@/components/ui";
import { AnonProfileCard } from "@/components/plan-setup/AnonProfileCard";
import { useAnonLibrary } from "@/lib/library/use-anon-library";
import { ANON_PERSON_ID, browserStores, loadAnonProfile, saveAnonDraft, saveAnonProfile } from "@/lib/plan/anon-draft";
import { anonFeasibility, generateAnonPlan } from "@/lib/plan/anon-generate";
import { DEFAULT_ANON_FORM, formToProfile, profileToForm } from "@/lib/plan/anon-profile-form";
import type { AnonProfileForm } from "@/lib/plan/anon-profile-form";
import { FoodStep } from "@/components/plan-setup/FoodStep";
import { MealsStep } from "@/components/plan-setup/MealsStep";
import { ReviewStep } from "@/components/plan-setup/ReviewStep";
import { RoutineStep } from "@/components/plan-setup/RoutineStep";
import { SummaryPanel } from "@/components/plan-setup/SummaryPanel";
import { WhoStep } from "@/components/plan-setup/WhoStep";
import { summarise } from "@/components/plan-setup/summary";
import { useFeasibility } from "@/components/plan-setup/useFeasibility";
import type { SetDraft, SetupProps } from "@/components/plan-setup/types";
import {
  blockers as draftBlockers,
  canSkip,
  DRAFT_KEY,
  feasibilityKey,
  MEAL_TYPES,
  nextStep,
  openingStep,
  parseDraft,
  prevStep,
  serializeDraft,
  shakeFix,
  STEP_LABEL,
  toCreatePlanInput,
  toFeasibilityInput,
  validateStep,
  withShake,
  WIZARD_STEPS,
} from "@/lib/plan/wizard";
import type { MealType, WizardDraft, WizardStep } from "@/lib/plan/wizard";

export type { SetupPerson, SetupProps } from "@/components/plan-setup/types";

function makeDraft(initial: SetupProps["initial"]): WizardDraft {
  return {
    personIds: initial.personIds,
    length: initial.length,
    start: initial.start,
    customEnd: initial.end,
    shoppingDay: null,
    prepDay: null,
    meals: initial.meals.filter((m): m is MealType => (MEAL_TYPES as readonly string[]).includes(m)),
    prepStyle: initial.prepStyle,
    timeLimit: initial.timeLimit,
    cuisine: initial.cuisineBalance,
    health: initial.health,
    pinned: [],
    prefs: initial.prefs,
  };
}

const STEPS = WIZARD_STEPS.map((id) => ({ id, label: STEP_LABEL[id] }));

/**
 * Plan setup as five short steps (who and when, meals and effort, food, daily routine, review). The step lives in the
 * address (`?step=`) so the browser's Back button works; the choices live in sessionStorage so a refresh keeps them.
 * Nothing is saved to the database until Generate, except routines, which save to the profile as they are changed.
 */
export function SetupForm({ people: memberPeople, ingredients, anchors, recipes, hasLastPlan, routines, initial, anonymous = false }: SetupProps & { /** A visitor without an account: one device-only profile, planning on the device, nothing sent to the server. */ anonymous?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const step = openingStep(params.get("step"), hasLastPlan);

  const library = useAnonLibrary();
  const [form, setForm] = useState<AnonProfileForm>(DEFAULT_ANON_FORM);
  const [showProfileErrors, setShowProfileErrors] = useState(false);
  const initialDraft = useMemo(() => makeDraft(initial), [initial]);
  const [draft, setDraftState] = useState<WizardDraft>(initialDraft);
  const anonPrefs = useMemo(() => draft.prefs[Number(ANON_PERSON_ID)] ?? { liked: [], avoided: [] }, [draft.prefs]);
  const profileResult = useMemo(() => formToProfile(form, anonPrefs), [form, anonPrefs]);
  const people = useMemo(() => {
    if (!anonymous) return memberPeople;
    const profile = profileResult.ok ? profileResult.profile : null;
    const target = profile ? (profile.protein.mode === "fixed" ? profile.protein.grams : Math.round(profile.protein.gPerKg * profile.protein.weightKg)) : 0;
    return [{ id: 1, name: profile?.name ?? (form.name.trim() || "You"), proteinTarget: target, kcalTarget: profile?.kcalTarget ?? null }];
  }, [anonymous, memberPeople, profileResult, form.name]);
  const [dirty, setDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [visitedRoutine, setVisitedRoutine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Pick up a draft kept from earlier in this tab (a refresh, or a trip to add a person).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        setDraftState(parseDraft(raw, initialDraft, anonymous ? [Number(ANON_PERSON_ID)] : memberPeople.map((p) => p.id)));
        setDirty(true);
      }
    } catch {
      /* sessionStorage can be blocked; the flow still works without it */
    }
    if (anonymous) {
      const saved = loadAnonProfile(browserStores(), new Date());
      if (saved) setForm(profileToForm(saved));
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraft, anonymous]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, serializeDraft(draft));
    } catch {
      /* ignore */
    }
  }, [draft, hydrated]);

  useEffect(() => {
    if (step === "routine") setVisitedRoutine(true);
  }, [step]);

  const setDraft: SetDraft = useCallback((patch) => {
    setDirty(true);
    setDraftState((d) => ({ ...d, ...patch }));
  }, []);

  const go = useCallback((to: WizardStep) => {
    // History API calls sync with useSearchParams, so Back and Forward work without asking the server again.
    window.history.pushState(null, "", `/plan/new?step=${to}`);
    setShowProblems(false);
    window.scrollTo({ top: 0 });
  }, []);

  const nameOf = useMemo(() => {
    const map = new Map(ingredients.map((i) => [i.slug, i.name]));
    for (const a of anchors) if (!map.has(a.slug)) map.set(a.slug, a.label);
    return (slug: string) => map.get(slug) ?? slug;
  }, [ingredients, anchors]);
  const recipeName = useCallback((slug: string) => recipes.find((r) => r.slug === slug)?.name ?? slug, [recipes]);
  const summary = useMemo(() => summarise(draft, people, nameOf, recipeName), [draft, people, nameOf, recipeName]);

  const problems = showProblems ? validateStep(step, draft) : [];
  const complete = validateStep("review", draft).length === 0;
  const anonReady = !anonymous || (library.status === "ready" && profileResult.ok);
  const feas = useFeasibility(
    step === "review" && complete && anonReady ? toFeasibilityInput(draft) : null,
    step === "review" ? `${feasibilityKey(draft)}|${anonymous ? `${library.status}|${JSON.stringify(profileResult.ok ? profileResult.profile : null)}` : ""}` : "off",
    400,
    anonymous ? async (input) => {
      if (library.status !== "ready" || !profileResult.ok) return { ok: false as const, error: "The recipe library is still loading." };
      return anonFeasibility(input, profileResult.profile, library.library);
    } : undefined,
  );
  const blocks = draftBlockers(draft, feas.result);
  const canShake = shakeFix(draft, feas.result);

  function onNext() {
    if (anonymous && step === "who" && !profileResult.ok) {
      setShowProfileErrors(true);
      return;
    }
    const found = validateStep(step, draft);
    if (found.length) {
      setShowProblems(true);
      return;
    }
    const to = nextStep(step);
    if (to) go(to);
  }

  function onSkip() {
    const to = nextStep(step);
    if (to) go(to);
  }

  function generateOnDevice() {
    setError(null);
    if (!profileResult.ok) {
      setShowProfileErrors(true);
      go("who");
      return;
    }
    if (library.status !== "ready") {
      setError("The recipe library is still loading. Try again in a moment.");
      return;
    }
    const stores = browserStores();
    const now = new Date();
    // The seed is chosen here, so the same plan can be rebuilt after signup.
    const seed = Math.floor(Math.random() * 2 ** 31);
    const result = generateAnonPlan({ setup: toCreatePlanInput(draft), profile: profileResult.profile, library: library.library, seed, now });
    if (!result.ok) {
      setError(result.error);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    saveAnonProfile(stores, profileResult.profile);
    if (!saveAnonDraft(stores, result.draft)) {
      setError("This browser would not keep the plan. Allow site storage or leave private browsing, then try again.");
      return;
    }
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    router.push("/plan/draft");
  }

  function generate() {
    if (anonymous) {
      generateOnDevice();
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await createPlan(toCreatePlanInput(draft));
      if (!res.ok) {
        setError(res.error);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      router.push(`/plan/${res.planId}?new=1`);
    });
  }

  const stepProps = { draft, setDraft, people, problems };
  const back = prevStep(step);
  const showRoutine = step === "routine" || visitedRoutine;

  const actionBar = (
    <StickyActionBar note={step === "review" && blocks.length ? <p className="text-bad lg:hidden" role="alert">{blocks[0]}</p> : null}>
      {back ? <Button variant="secondary" size="lg" onClick={() => go(back)}>Back</Button> : null}
      {step === "review" ? (
        <Button size="lg" className="flex-1 lg:hidden" onClick={generate} loading={pending} disabled={blocks.length > 0}>{pending ? "Planning" : "Generate plan"}</Button>
      ) : (
        <>
          {canSkip(step) ? <Button variant="ghost" size="lg" onClick={onSkip}>Skip</Button> : null}
          <Button size="lg" className="ml-auto min-w-32 flex-1 lg:flex-none" onClick={onNext}>Next</Button>
        </>
      )}
    </StickyActionBar>
  );

  return (
    <fieldset disabled={!hydrated} className="min-w-0 px-4 pb-32 lg:pb-10">
      {anonymous && library.status === "error" ? (
        <div className="mb-3"><Banner tone="bad" title="The recipe library did not load">
          <p>{library.message}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={library.retry}>Try again</Button>
        </Banner></div>
      ) : null}
      <Stepper steps={STEPS} current={step} onSelect={(id) => go(id as WizardStep)} label="Plan setup steps" />

      <div className="mt-4">
        {step === "review" ? (
          <>
            <ReviewStep
              summary={summary}
              onChange={go}
              state={feas}
              meals={draft.meals}
              repeat={hasLastPlan && !dirty}
              onShake={() => setDraft({ meals: withShake(draft).meals })}
              canShake={canShake}
              blockers={blocks}
              onGenerate={generate}
              pending={pending}
              error={error}
            />
            {actionBar}
          </>
        ) : (
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div>
              {step === "who" ? <WhoStep {...stepProps} whoSection={anonymous ? <AnonProfileCard form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} showErrors={showProfileErrors} /> : undefined} /> : null}
              {step === "meals" ? <MealsStep {...stepProps} /> : null}
              {step === "food" ? <FoodStep {...stepProps} ingredients={ingredients} anchors={anchors} recipes={recipes} /> : null}
              {showRoutine && anonymous ? (
                <div hidden={step !== "routine"}>
                  <SectionCard id="routines" title="Daily routine" description="Drinks and small habits on a schedule, such as methi water.">
                    <p className="text-sm text-muted">Routines are saved to your account. Make your plan first, then create an account and turn them on from your profile. Skip this step for now.</p>
                  </SectionCard>
                </div>
              ) : showRoutine ? (
                <div hidden={step !== "routine"}>
                  <RoutineStep {...stepProps} catalog={routines.catalog} chosen={routines.chosen} editablePersonIds={routines.editablePersonIds} />
                </div>
              ) : null}
              {actionBar}
            </div>
            <SummaryPanel summary={summary} onReview={() => go("review")} />
          </div>
        )}
      </div>
    </fieldset>
  );
}
