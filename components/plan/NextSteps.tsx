"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { markPlanStep } from "@/app/actions";
import { CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import type { PlanMilestones, PlanStep } from "@/lib/planner/feasibility-types";

/** A screen tells the strip that a step is done (for example after the first swap), without sharing state. */
export const PLAN_STEP_EVENT = "pk:plan-step";

export function announcePlanStep(planId: number, step: PlanStep): void {
  window.dispatchEvent(new CustomEvent(PLAN_STEP_EVENT, { detail: { planId, step } }));
}

const hiddenKey = (planId: number) => `pk-next-steps-hidden-${planId}`;

const ITEMS: { step: PlanStep; title: string; hint: string }[] = [
  { step: "reviewed", title: "Review and swap", hint: "Look through the days. Swap or lock any meal you do not want." },
  { step: "shopping", title: "What to buy", hint: "The grocery list is grouped by aisle, with your routines included." },
  { step: "prep", title: "Prep tonight", hint: "Soaks and make-ahead jobs for the next day or two." },
];

/**
 * The three things to do after a plan is made. Shows what is done and what is next, and goes away when all three are
 * done. Steps are marked from the screens that do them; the server keeps the record. Reusable on Today.
 */
export function NextSteps({ planId, milestones }: { planId: number; milestones: PlanMilestones }) {
  const [done, setDone] = useState<PlanMilestones>(milestones);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(hiddenKey(planId)) === "1");
    } catch {
      /* storage can be blocked; the strip just stays visible */
    }
  }, [planId]);

  // The ref holds the latest answer so marking is a plain function: no server call hides inside a state updater.
  const doneRef = useRef<PlanMilestones>(milestones);

  function mark(step: PlanStep) {
    if (doneRef.current[step]) return;
    doneRef.current = { ...doneRef.current, [step]: true };
    setDone(doneRef.current);
    // Fire and forget: the screen has already moved on, and the server record catches up. Undo if it is refused.
    void markPlanStep(planId, step).then((res) => {
      if (res.ok) return;
      doneRef.current = { ...doneRef.current, [step]: false };
      setDone(doneRef.current);
    });
  }

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ planId: number; step: PlanStep }>).detail;
      if (detail?.planId === planId) mark(detail.step);
    };
    window.addEventListener(PLAN_STEP_EVENT, onEvent);
    return () => window.removeEventListener(PLAN_STEP_EVENT, onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  if (hidden || (done.reviewed && done.shopping && done.prep)) return null;
  const nextIndex = ITEMS.findIndex((i) => !done[i.step]);

  return (
    <section aria-labelledby="next-steps-h" className="mx-4 mt-4 rounded-card border border-primary/30 bg-primarysoft p-4 lg:mx-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="next-steps-h" className="text-lg font-semibold">Your plan is ready. Three things left.</h2>
          <p className="text-sm text-muted">{ITEMS.filter((i) => done[i.step]).length} of 3 done</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { try { localStorage.setItem(hiddenKey(planId), "1"); } catch { /* ignore */ } setHidden(true); }}>Hide</Button>
      </div>
      <ol className="mt-3 grid gap-3 md:grid-cols-3">
        {ITEMS.map((item, i) => {
          const isDone = done[item.step];
          return (
            <li key={item.step} aria-current={i === nextIndex ? "step" : undefined} className={`flex flex-col rounded-control border p-3 ${isDone ? "border-ok/40 bg-surface" : i === nextIndex ? "border-primary bg-surface" : "border-line bg-surface"}`}>
              <div className="flex items-center gap-2">
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums ${isDone ? "border-ok bg-oksoft text-ok" : "border-strong"}`}>
                  {isDone ? <CheckIcon className="size-4" /> : i + 1}
                </span>
                <h3 className="text-base font-semibold">{item.title}</h3>
                {isDone ? <span className="ml-auto text-sm font-medium text-ok">Done</span> : null}
              </div>
              <p className="mt-1 flex-1 text-sm text-muted">{item.hint}</p>
              {!isDone ? (
                <div className="mt-3">
                  {item.step === "reviewed" ? <Button size="sm" onClick={() => mark("reviewed")}>Looks good</Button> : null}
                  {item.step === "shopping" ? <Link href="/groceries" onClick={() => mark("shopping")} className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-3 text-sm font-semibold text-primaryfg hover:opacity-90 lg:min-h-9">Open grocery list</Link> : null}
                  {item.step === "prep" ? <Link href={`/plan/${planId}/prep`} onClick={() => mark("prep")} className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-3 text-sm font-semibold text-primaryfg hover:opacity-90 lg:min-h-9">Open prep guide</Link> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
