"use client";

import { Button, Pill, Segmented } from "@/components/ui";
import { estimateHandsOnMin } from "@/lib/recipes/cookschedule";
import type { CookInput, CookPartInfo } from "@/lib/recipes/cookschedule";

interface Props {
  input: CookInput;
  alreadyMade: string[];
  onToggle: (slug: string, made: boolean) => void;
  onStart: () => void;
}

function PartRow({ part, alreadyMade, onToggle, depth }: { part: CookPartInfo; alreadyMade: string[]; onToggle: Props["onToggle"]; depth: number }) {
  const made = alreadyMade.includes(part.slug);
  return (
    <li className="rounded-card border border-line bg-surface p-4" style={{ marginLeft: depth * 16 }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-snug">{part.name}</p>
          <p className="text-sm text-muted">
            {part.label ? `${part.label}. ` : ""}
            {part.mode === "make" ? `About ${part.activeMin} min of cooking.` : part.mode === "buy" ? "You are buying this." : "You already have this."}
            {part.keeps && part.mode === "make" ? ` Keeps ${part.fridgeDays} days, so you can make it ahead.` : ""}
          </p>
        </div>
        {part.mode === "make" ? (
          <Segmented value={made ? "made" : "make"} onChange={(v) => onToggle(part.slug, v === "made")} label={`How you get ${part.name}`}
            options={[{ value: "make", label: "Make it now" }, { value: "made", label: "Already made" }]} />
        ) : (
          <Pill tone={part.mode === "buy" ? "warn" : "ok"}>{part.mode === "buy" ? "Buy" : "Have"}</Pill>
        )}
      </div>
    </li>
  );
}

/** Before the first step: which parts to cook now, and about how long it will take. */
export function StartScreen({ input, alreadyMade, onToggle, onStart }: Props) {
  const minutes = estimateHandsOnMin(input, alreadyMade);
  const depthOf = (p: CookPartInfo): number => (p.parentSlug ? 1 + depthOf(input.parts.find((x) => x.slug === p.parentSlug) ?? { ...p, parentSlug: null }) : 0);
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6 lg:px-8">
      <h1 className="font-display text-3xl font-semibold leading-tight">{input.mealName}</h1>
      <p className="mt-1 text-lg text-muted">This meal is made of parts. Skip any you already have in the fridge.</p>
      <ul className="mt-5 space-y-3">
        {input.parts.map((p) => <PartRow key={p.slug} part={p} alreadyMade={alreadyMade} onToggle={onToggle} depth={depthOf(p)} />)}
      </ul>
      <p className="mt-5 text-lg" aria-live="polite">About <strong className="font-display text-2xl tabular-nums">{minutes}</strong> minutes of hands-on cooking.</p>
      <p className="mt-1 text-sm text-muted">"Already made" is only for this session. Your plan is not changed.</p>
      <Button size="lg" className="mt-5 min-h-16 w-full text-xl" onClick={onStart}>Start cooking</Button>
    </div>
  );
}
