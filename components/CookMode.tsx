"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { ArrowLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Sheet } from "@/components/Sheet";
import { Button, LinkButton, SwitchRow } from "@/components/ui";
import { round1 } from "@/lib/format";

interface Step {
  text: string;
  timerSec: number | null;
  cue: string | null;
  tip: string | null;
  technique: { title: string; body: string } | null;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch {
    /* sound is a bonus; the on-screen message is the real signal */
  }
  if ("vibrate" in navigator) navigator.vibrate?.([300, 150, 300]);
}

export function CookMode({ slug, name, servings, steps, ingredients }: { slug: string; name: string; servings: number; steps: Step[]; ingredients: { name: string; grams: number }[] }) {
  const [i, setI] = useState(0);
  const [left, setLeft] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [awake, setAwake] = useState(false);
  const [wakeSupported, setWakeSupported] = useState(false);
  const [showIng, setShowIng] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const lock = useRef<WakeLockSentinel | null>(null);
  const step = steps[i]!;
  const last = i === steps.length - 1;

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

  // Reset the timer whenever the step changes.
  useEffect(() => {
    setRunning(false);
    setFinished(false);
    setLeft(step.timerSec);
  }, [i, step.timerSec]);

  useEffect(() => {
    if (!running || left === null) return;
    if (left <= 0) {
      setRunning(false);
      setFinished(true);
      beep();
      return;
    }
    const t = setTimeout(() => setLeft((l) => (l === null ? l : l - 1)), 1000);
    return () => clearTimeout(t);
  }, [running, left]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((c) => Math.min(steps.length - 1, c + 1));
      if (e.key === "ArrowLeft") setI((c) => Math.max(0, c - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 lg:px-6">
        <LinkButton href={`/recipes/${slug}`} variant="ghost" size="sm"><ArrowLeftIcon className="size-4" />Exit</LinkButton>
        <p className="min-w-0 truncate text-center font-display text-base font-semibold" title={name}>{name}</p>
        <Button variant="ghost" size="sm" onClick={() => setShowIng(true)}>Ingredients</Button>
      </div>

      <div className="h-1.5 w-full bg-surface2" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={i + 1} aria-label="Step progress">
        <div className="h-full bg-primary transition-all" style={{ width: `${((i + 1) / steps.length) * 100}%` }} />
      </div>

      <div className="flex flex-1 justify-center overflow-y-auto">
        <div className="flex w-full max-w-3xl flex-col justify-center px-5 py-6 lg:px-8">
          <p className="mb-3 text-base font-semibold text-muted">Step {i + 1} of {steps.length}</p>
          <p className="font-display text-[1.75rem] font-medium leading-snug lg:text-4xl lg:leading-snug" aria-live="polite">{step.text}</p>

          {step.cue ? (
            <p className="mt-5 rounded-card border border-ok bg-oksoft p-4 text-xl leading-snug text-ok">
              <span className="font-bold">Done when: </span>
              {step.cue}
            </p>
          ) : null}
          {step.tip ? <p className="mt-3 text-lg leading-snug text-muted"><span className="font-bold text-fg">Tip: </span>{step.tip}</p> : null}

          {left !== null ? (
            <div className="mt-6 rounded-card border border-line bg-surface p-4 text-center lg:flex lg:items-center lg:justify-between lg:text-left">
              <div>
                <p className={`font-display text-5xl font-bold tabular-nums lg:text-6xl ${finished ? "text-ok" : ""}`} role="timer" aria-live="off">{mmss(left)}</p>
                {finished ? <p className="mt-1 text-lg font-semibold text-ok" role="alert">Time is up</p> : null}
              </div>
              <div className="mt-3 flex justify-center gap-2 lg:mt-0">
                <Button size="lg" className="min-w-32" onClick={() => { if (finished) { setLeft(step.timerSec); setFinished(false); } setRunning((r) => !r); }}>{running ? "Pause" : finished ? "Restart" : left === step.timerSec ? "Start timer" : "Resume"}</Button>
                <Button size="lg" variant="secondary" onClick={() => { setRunning(false); setFinished(false); setLeft(step.timerSec); }}>Reset</Button>
              </div>
            </div>
          ) : null}

          {step.technique ? <Button variant="secondary" className="mt-5 self-start" onClick={() => setShowTech(true)}>How to: {step.technique.title}</Button> : null}
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
            <Button variant="secondary" size="lg" className="min-h-16 text-xl" disabled={i === 0} onClick={() => setI(i - 1)}><ArrowLeftIcon className="size-5" />Back</Button>
            {last ? (
              <LinkButton href={`/recipes/${slug}`} size="lg" className="col-span-2 min-h-16 bg-ok text-xl text-white">Done</LinkButton>
            ) : (
              <Button size="lg" className="col-span-2 min-h-16 text-xl" onClick={() => setI(i + 1)}>Next step<ChevronRightIcon className="size-5" /></Button>
            )}
          </div>
        </div>
      </div>

      <Sheet open={showIng} onClose={() => setShowIng(false)} title="Ingredients">
        <ul className="divide-y divide-line px-4 lg:px-5">
          {ingredients.map((g) => (
            <li key={g.name} className="flex min-h-12 items-center justify-between gap-3 py-2 text-lg"><span>{g.name}</span><span className="font-semibold tabular-nums">{g.grams < 10 ? round1(g.grams) : Math.round(g.grams)} g</span></li>
          ))}
        </ul>
        <p className="px-4 py-3 text-sm text-muted">For {servings} {servings === 1 ? "serving" : "servings"}.</p>
      </Sheet>
      <Sheet open={showTech} onClose={() => setShowTech(false)} title={step.technique?.title ?? "Technique"}>
        <div className="p-4">{step.technique ? <Markdown>{step.technique.body}</Markdown> : null}</div>
      </Sheet>
    </div>
  );
}
