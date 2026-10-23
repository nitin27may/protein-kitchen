"use client";

import { PartLinks } from "@/components/links/PartLinks";
import { StepLinks } from "@/components/links/StepLinks";
import { ModeSwitch } from "@/components/parts/ModeSwitch";
import { Pill } from "@/components/ui";
import { round1 } from "@/lib/format";
import type { PartMode, PartModes } from "@/lib/parts/mode";
import { effectiveMode } from "@/lib/recipes/timeline";
import type { PartView } from "@/lib/recipes/timeline";

const fmtGrams = (g: number) => (g < 10 ? `${round1(g)} g` : `${Math.round(g)} g`);
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * One part of a meal: what it is, how long it takes, how it is sourced for this plan, and, when it is being made,
 * its ingredients and steps. Parts nested inside it are drawn inside its card.
 */
export function PartCard({ part, modes, factor, onMode, busy, depth = 0 }: { part: PartView; modes: PartModes; factor: number; onMode: (slug: string, mode: PartMode) => void; busy: boolean; depth?: number }) {
  const mode = effectiveMode(part, modes);
  const chosen = modes[part.slug] ?? "make";
  const qty = part.displayQty ? `${part.displayQty * factor % 1 === 0 ? part.displayQty * factor : round1(part.displayQty * factor)} ${part.displayUnit ?? ""}`.trim() : null;
  const headingId = `part-${part.slug}`;

  return (
    <li className={`rounded-card border bg-surface p-4 ${mode === "make" ? "border-line" : "border-dashed border-strong"} ${depth ? "bg-surface2" : ""}`} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-lg font-semibold leading-snug">{part.name}</h3>
          <p className="mt-0.5 text-sm text-muted tabular-nums">
            {fmtGrams(part.grams * factor)}{qty ? `, ${qty}` : ""}
            {part.label ? <> · {part.label}</> : null}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill>{part.activeMin} min active, {part.totalMin} min total</Pill>
            <Pill tone={part.keeps ? "ok" : "warn"}>Keeps {days(part.fridgeDays)}</Pill>
            <Pill tone="info">Adds {Math.round(part.protein)} g protein</Pill>
          </div>
        </div>
        <ModeSwitch name={part.name} value={chosen === "buy" && !part.hasAlt ? "make" : chosen} onChange={(m) => onMode(part.slug, m)} canBuy={part.hasAlt} disabled={busy} />
      </div>

      {mode === "have" ? <p className="mt-3 text-sm text-muted">Already made. Left out of the shopping list and the prep plan.</p> : null}

      {mode === "buy" ? (
        <div className="mt-3 rounded-control bg-primarysoft px-3 py-2 text-sm">
          <p className="font-semibold text-primary">Buy store-bought {part.altName ? part.altName.charAt(0).toLowerCase() + part.altName.slice(1) : part.name.toLowerCase()}</p>
          <p className="text-muted">About {fmtGrams(part.grams * factor)} goes on the shopping list in place of the ingredients and steps below.</p>
        </div>
      ) : null}

      {mode === "make" ? (
        <div className="mt-3 space-y-2">
          {part.advancePrep.length ? (
            <p className="rounded-control bg-warnsoft px-3 py-2 text-sm text-warn">
              <span className="font-semibold">Plan ahead: </span>
              {part.advancePrep.map((a) => `${a.instruction.replace(/\.$/, "")}, about ${a.leadHours} hours ahead`).join(". ")}.
            </p>
          ) : null}

          <details className="group rounded-control border border-line">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between px-3 text-sm font-semibold">
              Ingredients <span className="font-normal text-muted">{part.ingredients.length}</span>
            </summary>
            <ul className="divide-y divide-line px-3 pb-1">
              {part.ingredients.map((i) => (
                <li key={i.slug} className="flex min-h-9 items-center justify-between gap-3 text-sm">
                  <span>{i.name}{i.state === "dry" ? <span className="text-muted"> (dry)</span> : null}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{fmtGrams(i.grams * factor)}</span>
                </li>
              ))}
            </ul>
          </details>

          <details className="group rounded-control border border-line" open={depth === 0 && part.steps.length <= 4}>
            <summary className="flex min-h-11 cursor-pointer items-center justify-between px-3 text-sm font-semibold">
              Steps <span className="font-normal text-muted">{part.steps.length}</span>
            </summary>
            <ol className="space-y-3 px-3 pb-3 pt-1">
              {part.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primarysoft font-display text-sm font-bold text-primary">{i + 1}</span>
                  <div className="min-w-0 max-w-prose">
                    <p className="text-sm leading-relaxed">{s.text}</p>
                    {s.cue ? <p className="mt-1.5 rounded-control bg-oksoft px-2.5 py-1.5 text-sm text-ok"><span className="font-semibold">Done when: </span>{s.cue}</p> : null}
                    {s.tip ? <p className="mt-1.5 text-sm text-muted"><span className="font-semibold text-fg">Tip: </span>{s.tip}</p> : null}
                    {s.timerSec ? <p className="mt-1.5"><Pill>{Math.round(s.timerSec / 60)} min timer</Pill></p> : null}
                    <StepLinks partSlug={part.slug} stepNo={i + 1} />
                  </div>
                </li>
              ))}
            </ol>
          </details>

          <PartLinks partSlug={part.slug} partName={part.name} />

          {part.children.length ? (
            <div>
              <p className="mb-2 text-sm font-semibold">Made inside {part.name.toLowerCase()}</p>
              <ul className="space-y-3">
                {part.children.map((c) => <PartCard key={c.slug} part={c} modes={modes} factor={factor} onMode={onMode} busy={busy} depth={depth + 1} />)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
