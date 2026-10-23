import type { PartMode } from "../parts/mode";

/**
 * The cooking order for a meal made of parts. Serialisable and free of heavy imports, so cook mode can re-run it in
 * the browser when someone marks a part "already made".
 */

/** A step with a timer this long or longer leaves your hands free. */
export const HANDS_OFF_SEC = 600;

export interface CookStepBase {
  index: number;
  text: string;
  cue: string | null;
  tip: string | null;
  /** Technique slug; the page passes the technique text separately. */
  technique: string | null;
  timerSec: number | null;
  handsOff: boolean;
}

export interface CookTrack {
  /** Part slug, or null for the meal's own steps. */
  slug: string | null;
  name: string;
  parentSlug: string | null;
  kind: "make" | "buy" | "meal";
  keeps: boolean;
  activeMin: number;
  /** Total time of this track's hands-off steps. The track with the most starts first. */
  handsOffSec: number;
  order: number;
  steps: CookStepBase[];
}

export interface CookPartInfo {
  slug: string;
  name: string;
  label: string | null;
  parentSlug: string | null;
  /** What the plan says, after "buy with no store-bought version" has become "make". */
  mode: PartMode;
  keeps: boolean;
  fridgeDays: number;
  activeMin: number;
  /** Only a part that is being made can be marked "already made" for this session. */
  canToggle: boolean;
}

export interface CookInput {
  recipeSlug: string;
  mealName: string;
  mealActiveMin: number;
  tracks: CookTrack[];
  parts: CookPartInfo[];
}

export interface CookStep {
  /** Stable for the same recipe, part and step, so timers and progress can refer to it. */
  id: string;
  partSlug: string | null;
  /** The part's name, or null for the meal's own steps. */
  partName: string | null;
  kind: "cook" | "buy";
  text: string;
  cue: string | null;
  tip: string | null;
  technique: string | null;
  timerSec: number | null;
  handsOff: boolean;
  /** "While the falafel bakes: make the hummus" when this step fills a hands-off wait. */
  whileHint: string | null;
  /** The part keeps two days or more, so it can be made ahead. */
  makeAhead: boolean;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What the thing that is waiting is doing, in the present tense, from its step text. */
export function waitVerb(text: string): string {
  if (/\b(bake|roast)\b/i.test(text)) return "bakes";
  if (/\bsoak/i.test(text)) return "soaks";
  if (/\b(simmer)\b/i.test(text)) return "simmers";
  if (/\b(boil|cook)\b/i.test(text)) return "cooks";
  if (/\bmarinat/i.test(text)) return "marinates";
  if (/\b(chill|refrigerate|cool|set)\b/i.test(text)) return "chills";
  if (/\b(rest|stand|sit)\b/i.test(text)) return "rests";
  if (/\b(prove|rise|ferment)\b/i.test(text)) return "rises";
  return "is timing";
}

const trackKey = (t: CookTrack): string => t.slug ?? "meal";

/** Estimated hands-on seconds for one step of a track, used to decide how much fits in a wait. */
const stepCostSec = (t: CookTrack): number => Math.max(30, (t.activeMin * 60) / Math.max(1, t.steps.length));

function removedSet(tracks: CookTrack[], alreadyMade: readonly string[]): Set<string> {
  const made = new Set(alreadyMade);
  const bySlug = new Map(tracks.filter((t) => t.slug).map((t) => [t.slug!, t]));
  const removed = new Set<string>();
  for (const t of tracks) {
    if (!t.slug) continue;
    for (let cur: CookTrack | undefined = t; cur; cur = cur.parentSlug ? bySlug.get(cur.parentSlug) : undefined) {
      if (cur.slug && made.has(cur.slug)) {
        removed.add(t.slug);
        break;
      }
    }
  }
  return removed;
}

/**
 * Orders every step of the meal:
 * 1. Shopping for bought parts.
 * 2. The part with the most hands-off time first, nested parts before the part they go into.
 * 3. Whenever a hands-off step starts a long timer, steps of another ready part fill the wait.
 * 4. The meal's own steps (putting it together) last.
 * `alreadyMade` skips those parts, and anything inside them, for this session only.
 */
export function schedule(input: CookInput, alreadyMade: readonly string[] = []): CookStep[] {
  const removed = removedSet(input.tracks, alreadyMade);
  const live = input.tracks.filter((t) => !(t.slug && removed.has(t.slug)));
  const buyTracks = live.filter((t) => t.kind === "buy").sort((a, b) => a.order - b.order);
  const made = live.filter((t) => t.kind === "make").sort((a, b) => a.order - b.order);
  const meal = live.find((t) => t.kind === "meal");

  const pos = new Map<string, number>();
  const at = (t: CookTrack) => pos.get(trackKey(t)) ?? 0;
  const finished = (t: CookTrack) => at(t) >= t.steps.length;
  const ready = (t: CookTrack) => made.every((c) => c.parentSlug !== t.slug || finished(c));
  const out: CookStep[] = [];

  const emit = (t: CookTrack, whileHint: string | null) => {
    const s = t.steps[at(t)]!;
    pos.set(trackKey(t), at(t) + 1);
    out.push({
      id: `${input.recipeSlug}/${trackKey(t)}/${t.kind === "buy" ? "buy" : s.index}`,
      partSlug: t.slug,
      partName: t.kind === "meal" ? null : t.name,
      kind: t.kind === "buy" ? "buy" : "cook",
      text: s.text,
      cue: s.cue,
      tip: s.tip,
      technique: s.technique,
      timerSec: s.timerSec,
      handsOff: s.handsOff,
      whileHint,
      makeAhead: t.kind === "make" && t.keeps && s.index === 0,
    });
  };

  const best = (pool: CookTrack[]) => pool.reduce((a, b) => (b.handsOffSec > a.handsOffSec || (b.handsOffSec === a.handsOffSec && b.order < a.order) ? b : a));

  /** Fills a wait of `budgetSec` with steps from other ready parts, most hands-off time first. */
  const fillWait = (holder: CookTrack, holderStepText: string, budgetSec: number) => {
    const holderName = lower(holder.kind === "meal" ? input.mealName : holder.name);
    let budget = budgetSec;
    while (budget > 0) {
      const others = made.filter((o) => o !== holder && !finished(o) && ready(o)).sort((a, b) => b.handsOffSec - a.handsOffSec || a.order - b.order);
      const o = others[0];
      if (!o) break;
      emit(o, `While the ${holderName} ${waitVerb(holderStepText)}: make the ${lower(o.name)}`);
      budget -= stepCostSec(o);
    }
  };

  for (const t of buyTracks) while (!finished(t)) emit(t, null);

  for (;;) {
    const pending = made.filter((t) => !finished(t));
    if (!pending.length) break;
    const readyNow = pending.filter(ready);
    const t = best(readyNow.length ? readyNow : pending);
    while (!finished(t)) {
      const s = t.steps[at(t)]!;
      emit(t, null);
      if (s.handsOff && s.timerSec) fillWait(t, s.text, s.timerSec);
    }
  }

  if (meal) while (!finished(meal)) emit(meal, null);
  return out;
}

/** Hands-on minutes for the parts still being made, plus the meal's own. */
export function estimateHandsOnMin(input: CookInput, alreadyMade: readonly string[] = []): number {
  const removed = removedSet(input.tracks, alreadyMade);
  const parts = input.tracks.filter((t) => t.kind === "make" && !(t.slug && removed.has(t.slug))).reduce((sum, t) => sum + t.activeMin, 0);
  return Math.round(parts + input.mealActiveMin);
}
