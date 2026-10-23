import type { Candidate, DayPersonSummary, GeneratedPlan, PersonTarget, PlanInput, PlannedSlot, PlanWarning, Slot } from "./types";

const SLOT_ORDER: readonly Slot[] = ["breakfast", "lunch", "dinner", "snack", "shake"];
const SLOT_WEIGHT: Record<Slot, number> = { breakfast: 0.25, lunch: 0.3, dinner: 0.3, snack: 0.15, shake: 0.15 };
const NO_REPEAT_DAYS = 3;
const MAX_USES_PER_PLAN = 2;
const WEEKNIGHT_ACTIVE_MIN = 20;
const MIN_SERVINGS = 0.5;
const MAX_SERVINGS = 2;
const KCAL_SLACK = 1.3;
const MIN_GAP_TO_REPORT_G = 5;
const MAX_BATCH_RUN = 3;

/** Small seeded generator. Same seed gives the same plan. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roundToQuarter(n: number): number {
  return Math.round(n * 4) / 4;
}

export function clampServings(n: number): number {
  return Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, roundToQuarter(n)));
}

/** 0 = Sunday ... 6 = Saturday, computed in UTC so time zones cannot shift the date. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeeknight(date: string): boolean {
  const d = weekday(date);
  return d >= 1 && d <= 5;
}

export function slotShares(mealTypes: readonly Slot[]): Record<string, number> {
  const total = mealTypes.reduce((sum, s) => sum + SLOT_WEIGHT[s], 0) || 1;
  return Object.fromEntries(mealTypes.map((s) => [s, SLOT_WEIGHT[s] / total]));
}

/** Quarter-serving portions that bring each person close to their share of the day's targets. */
export function portionsFor(candidate: Candidate, people: readonly PersonTarget[], share: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of people) {
    const byProtein = candidate.perServing.protein_g > 0 ? (p.proteinTargetG * share) / candidate.perServing.protein_g : 1;
    let s = byProtein;
    if (p.kcalTarget && candidate.perServing.kcal > 0) {
      const byKcal = (p.kcalTarget * share * KCAL_SLACK) / candidate.perServing.kcal;
      s = Math.min(s, Math.max(MIN_SERVINGS, byKcal));
    }
    out[p.id] = clampServings(s);
  }
  return out;
}

interface Ctx {
  input: PlanInput;
  byslug: Map<string, Candidate>;
  rng: () => number;
  used: Map<string, number>;
  lastUsedDay: Map<string, number>;
  indianPlanned: number;
  totalPlanned: number;
}

function eligible(c: Candidate, slot: Slot, date: string, input: PlanInput): boolean {
  if (c.banned) return false;
  // Sides and breads go with a meal; they are not planned as a meal on their own.
  if (c.family === "sides" || c.family === "breads") return false;
  if (c.rating !== null && c.rating <= 2) return false;
  // Shakes are opt-in: they appear only in the shake slot, and nothing else may use that slot.
  if (slot === "shake") {
    if (c.family !== "shakes") return false;
  } else {
    if (c.family === "shakes" || !c.mealSlots.includes(slot)) return false;
  }
  const limit = input.maxActiveMin ?? (isWeeknight(date) ? WEEKNIGHT_ACTIVE_MIN : null);
  if (limit !== null && c.activeMin > limit) return false;
  for (const p of input.people) for (const a of p.avoided) if (c.ingredients.has(a)) return false;
  return true;
}

function score(c: Candidate, slot: Slot, dayIdx: number, sameDayAnchors: Set<string>, lunchAnchors: readonly string[], share: number, ctx: Ctx): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  let v = 0;

  let likedHits = 0;
  for (const p of ctx.input.people) {
    for (const l of p.liked) {
      if (c.anchors.includes(l)) {
        v += 3;
        likedHits++;
      } else if (c.ingredients.has(l)) {
        v += 1;
        likedHits++;
      }
    }
  }
  if (likedHits) reasons.push("uses an ingredient you like");

  if (c.favourite) {
    v += 2;
    reasons.push("a favourite");
  }
  if (c.rating !== null && c.rating >= 4) v += 2;
  if (c.tested) v += 1;

  // Protein fit against the group's average share of the day.
  const avgTarget = ctx.input.people.reduce((s, p) => s + p.proteinTargetG, 0) / ctx.input.people.length;
  const wanted = avgTarget * share;
  if (wanted > 0) v += Math.min(c.perServing.protein_g / wanted, 1.3) * 3;

  // Healthy focus: gentle nudges, so protein targets and liked foods still decide most choices.
  const hf = ctx.input.healthFocus;
  if (hf?.nutrientDense && c.nutrientDense) {
    v += 2.5;
    reasons.push("nutrient-dense");
  }
  if (hf?.lowSugar && !c.lowSugar) v -= 4;
  if (hf?.light) v += c.light ? 1.5 : -1.5;

  if (c.anchors.some((a) => sameDayAnchors.has(a))) v -= 5;
  if (slot === "dinner" && c.anchors.some((a) => lunchAnchors.includes(a))) v -= 4;

  const uses = ctx.used.get(c.slug) ?? 0;
  v -= uses * 3;

  // Cuisine balance: nudge toward the requested Indian share.
  const projected = (ctx.indianPlanned + (c.isIndian ? 1 : 0)) / (ctx.totalPlanned + 1);
  v -= Math.abs(projected - ctx.input.cuisineBalance) * 2;

  v += ctx.rng();
  void dayIdx;
  return { value: v, reasons };
}

/** A leftover is eaten again, not cooked, so the time limit does not apply, but dislikes still do. */
function eligibleForLeftover(c: Candidate, input: PlanInput): boolean {
  if (c.banned) return false;
  for (const p of input.people) for (const a of p.avoided) if (c.ingredients.has(a)) return false;
  return true;
}

function recentlyUsed(slug: string, dayIdx: number, ctx: Ctx): boolean {
  const last = ctx.lastUsedDay.get(slug);
  return last !== undefined && dayIdx - last <= NO_REPEAT_DAYS;
}

export function summariseDays(slots: readonly PlannedSlot[], people: readonly PersonTarget[], byslug: ReadonlyMap<string, Candidate>, dates: readonly string[]): DayPersonSummary[] {
  const out: DayPersonSummary[] = [];
  for (const date of dates) {
    for (const p of people) {
      let protein = 0;
      let kcal = 0;
      for (const s of slots) {
        if (s.date !== date) continue;
        const c = byslug.get(s.recipeSlug);
        const servings = s.servings[p.id] ?? 0;
        if (!c) continue;
        protein += c.perServing.protein_g * servings;
        kcal += c.perServing.kcal * servings;
      }
      const status = protein >= p.proteinTargetG ? "met" : protein >= p.proteinTargetG * 0.85 ? "near" : "short";
      out.push({ date, personId: p.id, proteinG: protein, kcal, proteinTargetG: p.proteinTargetG, status });
    }
  }
  return out;
}

export function generatePlan(input: PlanInput, candidates: readonly Candidate[]): GeneratedPlan {
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const ctx: Ctx = { input, byslug, rng: mulberry32(input.seed), used: new Map(), lastUsedDay: new Map(), indianPlanned: 0, totalPlanned: 0 };
  const shares = slotShares(input.mealTypes);
  const slots: PlannedSlot[] = [];
  const warnings: PlanWarning[] = [];
  const mealOrder = SLOT_ORDER.filter((s) => input.mealTypes.includes(s));
  const pins = [...input.pinnedRecipes];
  const style = input.prepStyle ?? "variety";
  /** Batch style: the recipe and run length last used in each slot. */
  const lastBySlot = new Map<Slot, { slug: string; run: number }>();
  /** Leftovers style: tomorrow's lunch is tonight's dinner. */
  let leftoverForNextLunch: string | null = null;

  const place = (date: string, slot: Slot, dayIdx: number, c: Candidate, locked: boolean, reasons: string[], isLeftover = false) => {
    slots.push({ date, slot, recipeSlug: c.slug, servings: portionsFor(c, input.people, shares[slot] ?? 0.25), locked, reasons, isLeftover });
    ctx.used.set(c.slug, (ctx.used.get(c.slug) ?? 0) + 1);
    ctx.lastUsedDay.set(c.slug, dayIdx);
    ctx.totalPlanned++;
    if (c.isIndian) ctx.indianPlanned++;
  };

  input.dates.forEach((date, dayIdx) => {
    const sameDayAnchors = new Set<string>();
    let lunchAnchors: readonly string[] = [];
    let pinnedToday = false;
    const carried = leftoverForNextLunch;
    leftoverForNextLunch = null;

    for (const slot of mealOrder) {
      const lock = input.locked.find((l) => l.date === date && l.slot === slot);
      const lockedCandidate = lock ? byslug.get(lock.recipeSlug) : undefined;
      let chosen: Candidate | undefined;
      let reasons: string[] = [];

      const carriedCandidate = slot === "lunch" && carried && !lockedCandidate ? byslug.get(carried) : undefined;
      if (carriedCandidate && eligibleForLeftover(carriedCandidate, input)) {
        chosen = carriedCandidate;
        reasons = ["leftover from last night, no cooking"];
        place(date, slot, dayIdx, chosen, false, reasons, true);
      } else if (lockedCandidate) {
        chosen = lockedCandidate;
        reasons = ["locked by you"];
        place(date, slot, dayIdx, chosen, true, reasons);
      } else {
        const pool = candidates.filter((c) => c.activeMin >= 0 && eligible(c, slot, date, input));
        const prev = lastBySlot.get(slot);
        // Batch style: a recipe that keeps may run for a few days in the same slot.
        const continuing = style === "batch" && (slot === "lunch" || slot === "dinner") && prev && prev.run < MAX_BATCH_RUN ? pool.find((c) => c.slug === prev.slug && c.batchFriendly) : undefined;
        let open = pool.filter((c) => !recentlyUsed(c.slug, dayIdx, ctx) && (ctx.used.get(c.slug) ?? 0) < MAX_USES_PER_PLAN);
        if (continuing && !open.includes(continuing)) open = [...open, continuing];
        if (open.length === 0) open = pool.filter((c) => !recentlyUsed(c.slug, dayIdx, ctx));
        if (open.length === 0) open = pool;
        if (open.length < 3) warnings.push({ type: "few_options", date, slot, options: open.length });
        if (open.length === 0) continue;

        // One pinned recipe per day at most, in the first slot it fits, so pins spread across the plan.
        const pinIdx = pinnedToday ? -1 : pins.findIndex((p) => open.some((c) => c.slug === p));
        if (pinIdx >= 0) {
          chosen = open.find((c) => c.slug === pins[pinIdx]);
          pins.splice(pinIdx, 1);
          pinnedToday = true;
          reasons = ["pinned by you"];
        }
        if (!chosen) {
          let best = -Infinity;
          for (const c of open) {
            const sc = score(c, slot, dayIdx, sameDayAnchors, lunchAnchors, shares[slot] ?? 0.25, ctx);
            if (continuing && c === continuing) {
              sc.value += 12;
              sc.reasons.push("repeated from yesterday to cook once");
            }
            if (sc.value > best) {
              best = sc.value;
              chosen = c;
              reasons = sc.reasons;
            }
          }
        }
        if (!chosen) continue;
        place(date, slot, dayIdx, chosen, false, reasons);
      }
      if (chosen) {
        const prevRun = lastBySlot.get(slot);
        lastBySlot.set(slot, { slug: chosen.slug, run: prevRun?.slug === chosen.slug ? prevRun.run + 1 : 1 });
        if (slot === "dinner" && style === "leftovers" && chosen.fridgeDays >= 2 && input.mealTypes.includes("lunch")) leftoverForNextLunch = chosen.slug;
        for (const a of chosen.anchors) sameDayAnchors.add(a);
        if (slot === "lunch") lunchAnchors = chosen.anchors;
      }
    }
  });

  // Post-pass: close protein gaps by upgrading the snack, then report what is left.
  let days = summariseDays(slots, input.people, byslug, input.dates);
  for (const day of days) {
    if (day.status === "met") continue;
    const snack = slots.find((s) => s.date === day.date && s.slot === "snack" && !s.locked);
    if (!snack) continue;
    const dayIdx = input.dates.indexOf(day.date);
    const current = byslug.get(snack.recipeSlug);
    const better = candidates
      .filter((c) => eligible(c, "snack", day.date, input) && c.slug !== snack.recipeSlug && !recentlyUsed(c.slug, dayIdx, ctx))
      .filter((c) => !current || c.perServing.protein_g > current.perServing.protein_g)
      .sort((a, b) => b.perServing.protein_g - a.perServing.protein_g)[0];
    if (better) {
      snack.recipeSlug = better.slug;
      snack.servings = portionsFor(better, input.people, shares.snack ?? 0.15);
      snack.reasons = ["higher-protein snack to close the gap"];
      ctx.lastUsedDay.set(better.slug, dayIdx);
    }
  }
  days = summariseDays(slots, input.people, byslug, input.dates);

  const shakeOn = input.mealTypes.includes("shake");
  for (const d of days) {
    // Ignore shortfalls under 5 g: they are rounding, not a gap worth a banner.
    if (d.status === "met" || d.proteinTargetG - d.proteinG < MIN_GAP_TO_REPORT_G) continue;
    warnings.push({ type: "protein_gap", date: d.date, personId: d.personId, gapG: Math.round(d.proteinTargetG - d.proteinG), suggestion: shakeOn ? "choose_proteins" : "add_shake" });
  }
  for (const p of input.people) {
    for (const liked of p.liked) {
      if (!slots.some((s) => byslug.get(s.recipeSlug)?.ingredients.has(liked))) warnings.push({ type: "liked_unused", personId: p.id, ingredient: liked });
    }
  }
  for (const p of pins) warnings.push({ type: "pinned_unplaced", recipeSlug: p });

  return { slots, days, warnings };
}

/** Three swap suggestions for one slot: same slot, similar or higher protein, not used lately. */
export function suggestSwaps(
  plan: GeneratedPlan,
  slotRef: { date: string; slot: Slot },
  input: PlanInput,
  candidates: readonly Candidate[],
  count = 3,
): Candidate[] {
  const byslug = new Map(candidates.map((c) => [c.slug, c]));
  const current = plan.slots.find((s) => s.date === slotRef.date && s.slot === slotRef.slot);
  const currentCand = current ? byslug.get(current.recipeSlug) : undefined;
  const dayIdx = input.dates.indexOf(slotRef.date);
  const recent = new Set<string>();
  for (const s of plan.slots) {
    const i = input.dates.indexOf(s.date);
    if (Math.abs(i - dayIdx) <= NO_REPEAT_DAYS) recent.add(s.recipeSlug);
  }
  const target = currentCand?.perServing.protein_g ?? 0;
  const likedOf = (c: Candidate) => input.people.reduce((n, p) => n + [...p.liked].filter((l) => c.ingredients.has(l)).length, 0);
  return candidates
    .filter((c) => eligible(c, slotRef.slot, slotRef.date, input) && !recent.has(c.slug))
    .filter((c) => c.perServing.protein_g >= target * 0.85)
    .sort((a, b) => likedOf(b) - likedOf(a) || Math.abs(a.perServing.protein_g - target) - Math.abs(b.perServing.protein_g - target))
    .slice(0, count);
}
