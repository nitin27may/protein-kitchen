"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { LinkChips } from "@/components/links/LinkChips";
import { LinkItem } from "@/components/links/LinkItem";
import { VideoSheet } from "@/components/links/VideoSheet";
import { ArrowLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Sheet } from "@/components/Sheet";
import { Button, LinkButton, Pill, SwitchRow } from "@/components/ui";
import { StartScreen } from "@/components/cook/StartScreen";
import { TimerBar, TimerPanel, TimerStatus } from "@/components/cook/TimerTray";
import { useCookTimers } from "@/components/cook/useCookTimers";
import { round1 } from "@/lib/format";
import { formatClock, isDone, remainingMs, timersKey } from "@/lib/recipes/cooktimers";
import { schedule } from "@/lib/recipes/cookschedule";
import { cookSheetGroups, linksForCookStep } from "@/lib/recipes/linkview";
import type { OwnedLink } from "@/lib/recipes/linkview";
import type { CookInput } from "@/lib/recipes/cookschedule";

export interface CookTechnique {
  title: string;
  body: string;
}

interface Props {
  slug: string;
  name: string;
  servings: number;
  planId: number | null;
  input: CookInput;
  techniques: Record<string, CookTechnique>;
  ingredients: { name: string; grams: number }[];
  /** Saved links for this meal and its parts. Read only here; they are added and edited on the recipe page. */
  links: OwnedLink[];
}

const minutesLabel = (sec: number) => (sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);

export function CookMode({ slug, name, servings, planId, input, techniques, ingredients, links }: Props) {
  const hasParts = input.parts.length > 0;
  const [started, setStarted] = useState(!hasParts);
  const [alreadyMade, setAlreadyMade] = useState<string[]>([]);
  const [i, setI] = useState(0);
  const [awake, setAwake] = useState(false);
  const [wakeSupported, setWakeSupported] = useState(false);
  const [showIng, setShowIng] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  // Videos play in a sheet on top of cook mode, so the step, the timers and the screen lock are never left.
  const [playing, setPlaying] = useState<OwnedLink | null>(null);
  const lock = useRef<WakeLockSentinel | null>(null);
  const { timers, now, announcement, add, addTime, remove } = useCookTimers(timersKey(slug, planId));

  const steps = useMemo(() => schedule(input, alreadyMade), [input, alreadyMade]);
  const index = Math.min(i, steps.length - 1);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const technique = step.technique ? (techniques[step.technique] ?? null) : null;
  const stepTimer = timers.find((t) => t.stepId === step.id) ?? null;

  useEffect(() => setWakeSupported("wakeLock" in navigator), []);

  const setWake = useCallback(async (on: boolean) => {
    try {
      if (on) {
        lock.current = await navigator.wakeLock.request("screen");
        setAwake(true);
        lock.current.addEventListener("release", () => setAwake(false));
      } else {
        await lock.current?.release();
        lock.current = null;
        setAwake(false);
      }
    } catch {
      setAwake(false);
    }
  }, []);

  // Browsers drop the lock when the tab is hidden; ask again when it comes back.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && awake && !lock.current) void setWake(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock.current?.release();
    };
  }, [awake, setWake]);

  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((c) => Math.min(steps.length - 1, c + 1));
      if (e.key === "ArrowLeft") setI((c) => Math.max(0, c - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, steps.length]);

  const toggleMade = (partSlug: string, made: boolean) => setAlreadyMade((cur) => (made ? [...new Set([...cur, partSlug])] : cur.filter((s) => s !== partSlug)));

  const startTimer = () => {
    if (!step.timerSec) return;
    add({ stepId: step.id, label: step.partName ? `${step.partName}: step ${stepNumberInPart(index)}` : `Step ${index + 1}`, partName: step.partName, durationSec: step.timerSec });
  };
  /** The step's number within its own part, for the timer label. */
  const stepNumberInPart = (at: number) => steps.slice(0, at + 1).filter((s) => s.partSlug === steps[at]!.partSlug).length;
  const stepLinks = step.kind === "cook" ? linksForCookStep(links, step.partSlug, stepNumberInPart(index)) : [];
  const sheetGroups = useMemo(() => cookSheetGroups(links, name, input.parts.map((p) => ({ slug: p.slug, name: p.name, stepCount: 0 }))), [links, name, input.parts]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 lg:px-6">
        <LinkButton href={`/recipes/${slug}${planId ? `?plan=${planId}` : ""}`} variant="ghost" size="sm"><ArrowLeftIcon className="size-4" />Exit</LinkButton>
        <p className="min-w-0 truncate text-center font-display text-base font-semibold" title={name}>{name}</p>
        <div className="flex items-center">
          {links.length ? <Button variant="ghost" size="sm" onClick={() => setShowLinks(true)} aria-label={`Links, ${links.length} saved`}>Links ({links.length})</Button> : null}
          <Button variant="ghost" size="sm" onClick={() => setShowIng(true)}>Ingredients</Button>
        </div>
      </div>

      {!started ? (
        <div className="flex-1 overflow-y-auto">
          <StartScreen input={input} alreadyMade={alreadyMade} onToggle={toggleMade} onStart={() => { setI(0); setStarted(true); }} />
        </div>
      ) : (
        <>
          <div className="h-1.5 w-full bg-surface2" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-label="Step progress">
            <div className="h-full bg-primary transition-all" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-5 py-6 lg:grid lg:grid-cols-[minmax(0,48rem)_18rem] lg:justify-center lg:gap-8 lg:px-8">
              <div className="min-w-0">
                <TimerStatus timers={timers} now={now} announcement={announcement} />
                <TimerBar timers={timers} now={now} onAddTime={addTime} onRemove={remove} />

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <p className="text-base font-semibold text-muted">Step {index + 1} of {steps.length}</p>
                  {hasParts ? <Pill tone={step.kind === "buy" ? "warn" : "info"}>{step.partName ?? "Putting it together"}</Pill> : null}
                  {step.kind === "buy" ? <Pill tone="warn">Shopping</Pill> : null}
                  {step.makeAhead ? <Pill tone="ok">Can be made ahead</Pill> : null}
                </div>

                {step.whileHint ? (
                  <p className="mb-4 rounded-card border border-accent/40 bg-accentsoft p-3 text-lg font-semibold leading-snug text-accent" role="status">{step.whileHint}</p>
                ) : null}

                <p className="font-display text-[1.75rem] font-medium leading-snug lg:text-4xl lg:leading-snug" aria-live="polite">{step.text}</p>

                {step.cue ? (
                  <p className="mt-5 rounded-card border border-ok bg-oksoft p-4 text-xl leading-snug text-ok">
                    <span className="font-bold">Done when: </span>
                    {step.cue}
                  </p>
                ) : null}
                {step.tip ? <p className="mt-3 text-lg leading-snug text-muted"><span className="font-bold text-fg">Tip: </span>{step.tip}</p> : null}

                {step.timerSec ? (
                  <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4">
                    {stepTimer ? (
                      <>
                        <div>
                          <p className="text-base font-semibold text-muted">{isDone(stepTimer.endAt, now) ? "Time is up" : "Timer running"}</p>
                          <p className={`font-display text-5xl font-bold tabular-nums ${isDone(stepTimer.endAt, now) ? "text-ok" : ""}`}>{isDone(stepTimer.endAt, now) ? "Done" : formatClock(remainingMs(stepTimer.endAt, now))}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="lg" variant="secondary" onClick={() => addTime(stepTimer.id)}>Add 5 min</Button>
                          <Button size="lg" variant="ghost" onClick={() => remove(stepTimer.id)}>{isDone(stepTimer.endAt, now) ? "Dismiss" : "Cancel"}</Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <p className="text-base font-semibold text-muted">{step.handsOff ? "You can leave this one" : "Timer for this step"}</p>
                          <p className="font-display text-4xl font-bold tabular-nums">{minutesLabel(step.timerSec)}</p>
                        </div>
                        <Button size="lg" className="min-w-40" onClick={startTimer}>Start timer</Button>
                      </>
                    )}
                  </div>
                ) : null}

                {technique ? <Button variant="secondary" className="mt-5 self-start" onClick={() => setShowTech(true)}>How to: {technique.title}</Button> : null}

                <LinkChips links={stepLinks} onPlay={setPlaying} />
              </div>

              <TimerPanel timers={timers} now={now} onAddTime={addTime} onRemove={remove} />
            </div>
          </div>

          <div className="border-t border-line bg-surface px-4 pt-3" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
            <div className="mx-auto max-w-3xl">
              {wakeSupported ? (
                <div className="mb-1 [&_label]:min-h-11 [&_label]:py-0">
                  <SwitchRow checked={awake} onChange={(on) => void setWake(on)} title="Keep the screen on" />
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-3">
                <Button variant="secondary" size="lg" className="min-h-16 text-xl" disabled={index === 0} onClick={() => setI(index - 1)}><ArrowLeftIcon className="size-5" />Back</Button>
                {last ? (
                  <LinkButton href={`/recipes/${slug}${planId ? `?plan=${planId}` : ""}`} size="lg" className="col-span-2 min-h-16 bg-ok text-xl text-white">Done</LinkButton>
                ) : (
                  <Button size="lg" className="col-span-2 min-h-16 text-xl" onClick={() => setI(index + 1)}>Next step<ChevronRightIcon className="size-5" /></Button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <Sheet open={showIng} onClose={() => setShowIng(false)} title="Ingredients">
        <ul className="divide-y divide-line px-4 lg:px-5">
          {ingredients.map((g) => (
            <li key={g.name} className="flex min-h-12 items-center justify-between gap-3 py-2 text-lg"><span>{g.name}</span><span className="font-semibold tabular-nums">{g.grams < 10 ? round1(g.grams) : Math.round(g.grams)} g</span></li>
          ))}
        </ul>
        <p className="px-4 py-3 text-sm text-muted">For {servings} {servings === 1 ? "serving" : "servings"}.</p>
      </Sheet>
      <Sheet open={showTech} onClose={() => setShowTech(false)} title={technique?.title ?? "Technique"}>
        <div className="p-4">{technique ? <Markdown>{technique.body}</Markdown> : null}</div>
      </Sheet>
      <Sheet open={showLinks} onClose={() => setShowLinks(false)} title="Watch and read">
        <div className="space-y-5 p-4">
          {sheetGroups.length === 0 ? <p className="text-sm text-muted">No links for the whole meal or its parts. Links for a single step show under that step.</p> : null}
          {sheetGroups.map((g) => (
            <section key={g.partSlug ?? "meal"} aria-label={g.name}>
              <h3 className="mb-2 text-base font-semibold">{g.name}</h3>
              <ul className="space-y-2">
                {g.links.map((l) => <LinkItem key={l.id} link={l} actions={{ onPlay: setPlaying }} />)}
              </ul>
            </section>
          ))}
        </div>
      </Sheet>
      {playing ? <VideoSheet key={playing.id} link={playing} onClose={() => setPlaying(null)} /> : null}
    </div>
  );
}
