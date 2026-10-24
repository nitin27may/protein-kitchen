import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import Link from "next/link";
import { CheckIcon, SearchIcon, SlidersIcon, XIcon } from "@/components/icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
/** Phones keep a 44 px tap target; wide screens with a pointer can be a little tighter. */
const sizes: Record<Size, string> = {
  sm: "min-h-11 px-3 text-sm lg:min-h-9",
  md: "min-h-11 px-4 text-base lg:min-h-10 lg:text-[0.95rem]",
  lg: "min-h-12 px-6 text-base lg:min-h-12 lg:text-lg",
};
const variants: Record<Variant, string> = {
  primary: "bg-primary text-primaryfg hover:opacity-90",
  secondary: "border border-line bg-surface text-fg hover:bg-surface2",
  ghost: "text-primary hover:bg-primarysoft",
  danger: "border border-bad text-bad hover:bg-badsoft",
};

export function Button({ variant = "primary", size = "md", loading = false, className = "", children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button type="button" {...props} disabled={disabled || loading} aria-busy={loading || undefined} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "primary", size = "md", className = "", children }: { href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card border border-line bg-surface p-4 ${className}`}>{children}</section>;
}

export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="mx-4 mt-6 rounded-card border border-dashed border-line bg-surface p-6 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export type Tone = "ok" | "warn" | "bad" | "info";
const tones: Record<Tone, string> = {
  ok: "bg-oksoft text-ok border-ok/30",
  warn: "bg-warnsoft text-warn border-warn/30",
  bad: "bg-badsoft text-bad border-bad/30",
  info: "bg-primarysoft text-primary border-primary/30",
};

export function Banner({ tone = "info", title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`rounded-control border p-3 text-sm ${tones[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : ""}>{children}</div> : null}
    </div>
  );
}

export function Pill({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

/** Protein progress. Colour is never the only signal: the numbers and a word are always shown. */
export function ProteinBar({ value, target, label }: { value: number; target: number; label?: string }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const status = value >= target ? "met" : value >= target * 0.85 ? "near" : "short";
  const colour = status === "met" ? "bg-ok" : status === "near" ? "bg-warn" : "bg-bad";
  const word = status === "met" ? "on target" : status === "near" ? "close" : "below";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label ?? "Protein"}</span>
        <span className="tabular-nums">
          <strong>{Math.round(value)}</strong> of {Math.round(target)} g <span className="text-muted">({word})</span>
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label ?? "Protein"}: ${Math.round(value)} of ${Math.round(target)} grams, ${word}`}
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface2"
      >
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MacroLine({ protein, kcal, minutes }: { protein: number; kcal: number; minutes?: number }) {
  return (
    <p className="text-sm text-muted tabular-nums">
      <strong className="text-fg">{Math.round(protein)} g</strong> protein · {Math.round(kcal)} kcal
      {minutes !== undefined ? ` · ${minutes} min` : ""}
    </p>
  );
}

// ---------- Controls ----------
// One vocabulary for every screen. Pick one: Segmented. Pick several: Chip. On or off: SwitchRow. A choice that needs
// explaining: ChoiceCard. Text: Field with Input, Select or SearchField.

/**
 * Toggle chip for filters and multi-select. Shows a check when on, so colour is never the only signal.
 * With `removable` it is an active-filter chip: an X at the end, and it is a button that removes the filter.
 */
export function Chip({ on, onClick, children, count, className = "", removable = false, disabled = false, label }: { on: boolean; onClick: () => void; children: ReactNode; count?: number; className?: string; removable?: boolean; disabled?: boolean; label?: string }) {
  const name = label ?? (typeof children === "string" ? children : undefined);
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      {...(removable ? { "aria-label": name ? `Remove ${name}` : "Remove filter" } : { "aria-pressed": on })}
      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 lg:min-h-9 ${on ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface text-fg hover:bg-surface2"} ${className}`}>
      {on && !removable ? <CheckIcon className="size-4" /> : null}
      {children}
      {count !== undefined ? <span className={`tabular-nums text-xs font-medium ${on ? "text-primary" : "text-muted"}`}>{count}</span> : null}
      {removable ? <XIcon className="size-3.5" /> : null}
    </button>
  );
}

/** Pick exactly one of a few short options. */
export function Segmented<T extends string>({ value, onChange, options, label, className = "" }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex rounded-control border border-strong bg-surface2 p-0.5 ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={`min-h-10 flex-1 whitespace-nowrap rounded-[0.5rem] px-4 text-sm font-semibold transition-colors lg:min-h-8 ${on ? "bg-surface text-primary shadow-sm ring-1 ring-primary/40" : "text-muted hover:text-fg"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A choice that needs a line of explanation. Radio when `type` is "radio", checkbox otherwise. */
export function ChoiceCard({ type, name, checked, onChange, title, hint }: { type: "radio" | "checkbox"; name?: string; checked: boolean; onChange: (checked: boolean) => void; title: string; hint?: string }) {
  return (
    <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-card border p-3 transition-colors ${checked ? "border-primary bg-primarysoft" : "border-strong bg-surface hover:bg-surface2"}`}>
      <input type={type} name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
      <span className="min-w-0">
        <span className="block text-base font-semibold leading-snug">{title}</span>
        {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** On or off. Reads as a switch, with the explanation beside it. */
export function SwitchRow({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  return (
    <label className="flex min-h-14 cursor-pointer items-center justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-base font-semibold leading-snug">{title}</span>
        {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span className="h-7 w-12 rounded-full border border-strong bg-surface2 transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary" />
        <span className="pointer-events-none absolute left-1 size-5 rounded-full bg-fg/70 transition-transform peer-checked:translate-x-5 peer-checked:bg-primaryfg" />
      </span>
    </label>
  );
}

export const inputClass = "min-h-11 w-full rounded-control border border-strong bg-surface px-3 text-base placeholder:text-muted disabled:opacity-60 lg:min-h-10";

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-semibold">{label}</label>
      {children}
      {error ? <p className="mt-1 text-sm text-bad" role="alert">{error}</p> : hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${className}`} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${className}`} />;
}

export function SearchField({ id, value, onChange, placeholder, label, className = "" }: { id: string; value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
      <input id={id} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off"
        className={`${inputClass} pl-10 pr-10 [&::-webkit-search-cancel-button]:hidden`} />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search" className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-muted hover:bg-surface2 hover:text-fg">
          <XIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ResultCount({ shown, total, noun, onClear }: { shown: number; total: number; noun: string; onClear?: (() => void) | undefined }) {
  const filtered = shown !== total;
  return (
    <p className="flex items-center gap-3 text-sm text-muted" aria-live="polite">
      <span>{filtered ? `${shown} of ${total}` : total} {noun}</span>
      {filtered && onClear ? <button type="button" onClick={onClear} className="min-h-9 font-semibold text-primary underline-offset-2 hover:underline">Clear filters</button> : null}
    </p>
  );
}

/** A titled block of a form. Sentence-case heading, no decoration. */
export function SectionCard({ id, title, description, action, children }: { id: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-card border border-line bg-surface p-4 lg:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-semibold leading-snug">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------- List filtering ----------
// A list has one toolbar row (search, sort, Filters), one row of active filters or presets, and a panel for the options.

export function ListToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 lg:gap-3">{children}</div>;
}

/** Opens the filter panel. The badge says how many filters are on. */
export function FilterButton({ count, onClick, expanded }: { count: number; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-haspopup="dialog" aria-expanded={expanded}
      className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3.5 text-base font-semibold transition-colors lg:min-h-10 lg:text-[0.95rem] ${count ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>
      <SlidersIcon className="size-5" />
      Filters
      {count ? <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold tabular-nums text-primaryfg" aria-label={`${count} on`}>{count}</span> : null}
    </button>
  );
}

/** Sort as a labelled select. Native, so phones get their own picker. */
export function SortMenu({ value, onChange, options, label = "Sort by" }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label?: string }) {
  return (
    <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">
      <span className="font-semibold text-muted max-lg:sr-only">{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-auto">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </label>
  );
}

export function PresetChips({ presets, onApply }: { presets: { id: string; label: string; active: boolean }[]; onApply: (id: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick filters">
      <span className="text-sm font-semibold text-muted">Quick</span>
      {presets.map((p) => <Chip key={p.id} on={p.active} onClick={() => onApply(p.id)}>{p.label}</Chip>)}
    </div>
  );
}

/**
 * The row under the toolbar. With filters on it shows each one as a removable chip, the count and Clear all; with none
 * on it shows the quick presets and the count, so the layout does not jump when a filter is added.
 */
export function ActiveFilters({ chips, onRemove, onClear, presets, onPreset, shown, total, noun }: {
  chips: { facet: string; value: string; label: string }[];
  onRemove: (facet: string, value: string) => void;
  onClear: () => void;
  presets: { id: string; label: string; active: boolean }[];
  onPreset: (id: string) => void;
  shown: number;
  total: number;
  noun: string;
}) {
  const filtered = shown !== total;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {chips.length ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active filters">
          {chips.map((c) => <Chip key={`${c.facet}:${c.value}`} on removable onClick={() => onRemove(c.facet, c.value)}>{c.label}</Chip>)}
          <button type="button" onClick={onClear} className="min-h-11 px-1 text-sm font-semibold text-primary underline-offset-2 hover:underline lg:min-h-9">Clear all</button>
        </div>
      ) : presets.length ? (
        <PresetChips presets={presets} onApply={onPreset} />
      ) : null}
      <p className="text-sm text-muted lg:ml-auto" aria-live="polite">{filtered ? `${shown} of ${total}` : total} {noun}</p>
    </div>
  );
}

/**
 * One group of options in the filter panel. Native <details> hides everything after the first few, so a long list
 * (aisles) stays short without any state. Zero-count options are disabled unless they are already chosen.
 */
export function FilterSection({ title, hint, options, onToggle, showFirst = 6 }: {
  title: string;
  hint?: string;
  options: { value: string; label: string; count: number; selected: boolean }[];
  onToggle: (value: string) => void;
  showFirst?: number;
}) {
  const chip = (o: (typeof options)[number]) => (
    <Chip key={o.value} on={o.selected} count={o.count} disabled={o.count === 0 && !o.selected} onClick={() => onToggle(o.value)}>{o.label}</Chip>
  );
  const head = options.slice(0, showFirst);
  const rest = options.slice(showFirst);
  const restSelected = rest.some((o) => o.selected);
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-semibold">{title}</legend>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">{head.map(chip)}</div>
      {rest.length ? (
        <details className="mt-2" open={restSelected}>
          <summary className="min-h-9 cursor-pointer text-sm font-semibold text-primary">Show {rest.length} more</summary>
          <div className="mt-2 flex flex-wrap gap-2">{rest.map(chip)}</div>
        </details>
      ) : null}
    </fieldset>
  );
}

// ---------- Guided flows ----------

/**
 * Progress through a short sequence. Wide screens show every step by name; phones show 'Step 2 of 5: Meals' and a bar.
 * Earlier steps get a check, the current one has aria-current. Any step can be opened: nothing is saved by moving about.
 */
export function Stepper({ steps, current, onSelect, label }: { steps: { id: string; label: string }[]; current: string; onSelect?: (id: string) => void; label: string }) {
  const index = Math.max(0, steps.findIndex((s) => s.id === current));
  const active = steps[index];
  return (
    <nav aria-label={label}>
      <p className="text-sm font-semibold lg:hidden">
        Step {index + 1} of {steps.length}: <span className="font-normal text-muted">{active?.label}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface2 lg:hidden" aria-hidden="true">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className="hidden items-center gap-2 lg:flex">
        {steps.map((s, i) => {
          const done = i < index;
          const on = i === index;
          return (
            <li key={s.id} className="flex flex-1 items-center gap-2 last:flex-none">
              <button type="button" aria-current={on ? "step" : undefined} onClick={() => onSelect?.(s.id)}
                className={`flex min-h-10 items-center gap-2 rounded-control px-2 text-sm font-semibold transition-colors hover:bg-surface2 ${on ? "text-primary" : done ? "text-fg" : "text-muted"}`}>
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums ${on ? "border-primary bg-primary text-primaryfg" : done ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface"}`}>
                  {done ? <CheckIcon className="size-4" /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < steps.length - 1 ? <span className={`h-px flex-1 ${done ? "bg-primary" : "bg-line"}`} aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Back, Next and the like. Fixed to the bottom on phones so it stays in reach; an ordinary row on wide screens. */
export function StickyActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur lg:static lg:z-auto lg:mt-6 lg:border-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:backdrop-blur-none"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {note ? <div className="mb-2 text-sm">{note}</div> : null}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
