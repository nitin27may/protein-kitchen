"use client";

import { PART_MODES, PART_MODE_LABEL } from "@/lib/parts/mode";
import type { PartMode } from "@/lib/parts/mode";

/**
 * Make, Buy or Have for one part. Buy is disabled when the part has no store-bought alternative, and says why.
 * Local to the parts section because the shared Segmented control cannot disable a single option.
 */
export function ModeSwitch({ name, value, onChange, canBuy, disabled = false }: { name: string; value: PartMode; onChange: (m: PartMode) => void; canBuy: boolean; disabled?: boolean }) {
  return (
    <div>
      <div role="radiogroup" aria-label={`How you get ${name}`} className="inline-flex rounded-control border border-strong bg-surface2 p-0.5">
        {PART_MODES.map((m) => {
          const on = m === value;
          const blocked = disabled || (m === "buy" && !canBuy);
          return (
            <button key={m} type="button" role="radio" aria-checked={on} disabled={blocked} onClick={() => onChange(m)}
              title={m === "buy" && !canBuy ? "No store-bought version is set up for this part" : undefined}
              className={`min-h-11 min-w-20 whitespace-nowrap rounded-[0.5rem] px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 lg:min-h-9 ${on ? "bg-surface text-primary shadow-sm ring-1 ring-primary/40" : "text-muted hover:text-fg"}`}>
              {PART_MODE_LABEL[m]}
            </button>
          );
        })}
      </div>
      {!canBuy ? <p className="mt-1 text-xs text-muted">No store-bought version for this part.</p> : null}
    </div>
  );
}
