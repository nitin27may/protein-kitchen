import type { PartMode, PartModes } from "../parts/mode";

/**
 * Plain, serialisable views of the parts of a meal, and the timeline built from them.
 * Kept free of heavy imports so the recipe page can run `buildTimeline` in the browser when a part's mode changes.
 */

export interface PartIngredientView {
  slug: string;
  name: string;
  state: string;
  /** Grams for the number of servings being viewed. */
  grams: number;
}

export interface PartStepView {
  text: string;
  cue: string | null;
  tip: string | null;
  timerSec: number | null;
}

export interface PartAdvance {
  leadHours: number;
  instruction: string;
}

export interface PartView {
  slug: string;
  name: string;
  /** Role in this meal, for example "Dip". */
  label: string | null;
  displayQty: number | null;
  displayUnit: string | null;
  /** Grams of the part for the number of servings being viewed. */
  grams: number;
  fridgeDays: number;
  /** Keeps two days or more, so it can be made ahead. */
  keeps: boolean;
  activeMin: number;
  totalMin: number;
  /** The part's own ingredients only; nested parts are in `children`. */
  ingredients: PartIngredientView[];
  steps: PartStepView[];
  advancePrep: PartAdvance[];
  /** What the part adds to ONE serving of the meal. Nested parts are already included in their parent's numbers. */
  protein: number;
  kcal: number;
  fibre: number;
  hasAlt: boolean;
  altSlug: string | null;
  altName: string | null;
  children: PartView[];
}

export interface TimelineLine {
  when: string;
  what: string;
  /** `when` and `what` as one sentence, for example "The night before: soak chickpeas". */
  text: string;
}

export interface TimelineOptions {
  /** Advance prep the meal itself needs (not its parts). */
  mealAdvancePrep?: PartAdvance[];
  /** What happens on the day for the meal itself. */
  finalStep?: string;
}

/** A part marked "buy" with no store-bought alternative can only be made, as in the grocery list. */
export function effectiveMode(part: Pick<PartView, "slug" | "hasAlt">, modes: PartModes): PartMode {
  const mode = modes[part.slug] ?? "make";
  return mode === "buy" && !part.hasAlt ? "make" : mode;
}

/** The parts that actually get cooked, parts inside a bought or already-made part left out. */
export function partsToMake(parts: PartView[], modes: PartModes): PartView[] {
  return parts.flatMap((p) => (effectiveMode(p, modes) === "make" ? [p, ...partsToMake(p.children, modes)] : []));
}

function partsToBuy(parts: PartView[], modes: PartModes): PartView[] {
  return parts.flatMap((p) => {
    const mode = effectiveMode(p, modes);
    if (mode === "buy") return [p];
    return mode === "make" ? partsToBuy(p.children, modes) : [];
  });
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const firstSentence = (s: string) => s.trim().split(/\.\s/)[0]!.replace(/\.$/, "");
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** How far before cooking an advance task is due, in words. */
export function leadLabel(leadHours: number): string {
  if (leadHours >= 36) return `${days(Math.ceil(leadHours / 24))} before`;
  if (leadHours > 4) return "The night before";
  return `${Math.max(1, Math.round(leadHours))} ${Math.round(leadHours) <= 1 ? "hour" : "hours"} before`;
}

const line = (when: string, what: string): TimelineLine => ({ when, what, text: `${when}: ${what}` });

/**
 * Ordered, plain-language steps for the whole meal, earliest first:
 * shopping for bought parts, then soaks and other advance prep, then parts that keep and can be made ahead, then the day itself.
 * Parts marked buy or have are left out of the cooking lines.
 */
export function buildTimeline(parts: PartView[], modes: PartModes, opts: TimelineOptions = {}): TimelineLine[] {
  const lines: TimelineLine[] = [];
  const make = partsToMake(parts, modes);
  const buy = partsToBuy(parts, modes);

  if (buy.length) lines.push(line("When you shop", `buy ${list(buy.map((p) => p.altName ?? p.name))}`));

  const advance = [...make.flatMap((p) => p.advancePrep), ...(opts.mealAdvancePrep ?? [])];
  const byLabel = new Map<string, { lead: number; tasks: string[] }>();
  for (const a of advance) {
    const label = leadLabel(a.leadHours);
    const entry = byLabel.get(label) ?? { lead: a.leadHours, tasks: [] };
    entry.lead = Math.max(entry.lead, a.leadHours);
    const task = lowerFirst(firstSentence(a.instruction));
    if (!entry.tasks.includes(task)) entry.tasks.push(task);
    byLabel.set(label, entry);
  }
  [...byLabel.entries()]
    .sort((a, b) => b[1].lead - a[1].lead)
    .forEach(([label, e]) => lines.push(line(label, list(e.tasks))));

  const ahead = make.filter((p) => p.keeps);
  if (ahead.length) lines.push(line(`Up to ${days(Math.min(...ahead.map((p) => p.fridgeDays)))} ahead`, `make ${list(ahead.map((p) => lowerFirst(p.name)))}`));

  const fresh = make.filter((p) => !p.keeps).map((p) => `make ${lowerFirst(p.name)}`);
  lines.push(line("On the day", list([...fresh, opts.finalStep ?? "put it together"])));
  return lines;
}
