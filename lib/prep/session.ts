import type { Recipe } from "../schemas";
import { addDays } from "../planner/dates";
import { lastWeekdayOnOrBefore } from "../planner/weekdays";
import type { IsoWeekday } from "../routines/types";
import type { PartModes } from "../parts/mode";
import { partIsMade, resolverFor } from "../parts/resolve";

export interface MealRef {
  date: string;
  slot: string;
  recipeSlug: string;
  /** Total servings cooked for this meal, across everyone eating it. */
  servings: number;
  /** A reheat of food cooked for an earlier meal. It never triggers its own cooking day. */
  leftover?: boolean;
}

export interface Advance {
  /** Position of this entry in the recipe's `advance_prep`. Stable across edits to the wording. */
  index: number;
  instruction: string;
  /** Grams scaled to this cook, when the entry has a weight. */
  grams: number | null;
  text: string;
  /** The evening this must be done: the day before cooking, or earlier for long lead times. */
  dueDate: string;
}

export interface CookEvent {
  id: string;
  kind: "recipe" | "component";
  slug: string;
  name: string;
  cookDate: string;
  /** Cooked on the day it is eaten, not ahead. */
  fresh: boolean;
  /** Multiples of the recipe as written. */
  scale: number;
  servings: number;
  /** Components only: grams needed across the plan, and grams one batch makes. */
  neededG: number | null;
  yieldG: number | null;
  covers: { date: string; slot: string; recipeSlug: string }[];
  /** Last day the food is still good, from the recipe's fridge days. */
  useBy: string;
  activeMin: number;
  totalMin: number;
  passiveMin: number;
  equipment: string[];
  advance: Advance[];
}

export interface PrepSession {
  date: string;
  events: CookEvent[];
  activeMin: number;
  /** A rough wall-clock estimate if you work in parallel. */
  wallMin: number;
  equipment: string[];
}

export interface EatLine {
  date: string;
  slot: string;
  recipeSlug: string;
  mode: "batch" | "fresh";
  cookDate: string;
  useBy: string;
  activeMin: number;
}

export interface PrepGuide {
  events: CookEvent[];
  sessions: PrepSession[];
  nightBefore: { dueDate: string; text: string; forName: string }[];
  eat: EatLine[];
}

interface Options {
  /** Nothing can be cooked before this date, usually today. */
  earliest: string;
  /** The plan's part modes. A part marked "have", or "buy" with a ready-made alternative, is not cooked, so it gets no cook event and no night-before tasks. */
  partModes?: PartModes;
  /**
   * The weekday to batch cook on (ISO 1 to 7). A batch is cooked on the last such day on or before the day before its
   * first meal, as long as the food still keeps until then. Unset: cook the day before, as always. Use
   * `effectivePrepDay` so it only applies to the leftovers and batch cooking styles.
   */
  prepDay?: IsoWeekday | null;
}

/** The prep day only matters when the plan cooks ahead. Variety plans (and plans from before cooking styles) ignore it. */
export function effectivePrepDay(prepDay: IsoWeekday | null | undefined, prepStyle: "variety" | "leftovers" | "batch" | null | undefined): IsoWeekday | null {
  return prepDay && (prepStyle === "leftovers" || prepStyle === "batch") ? prepDay : null;
}

const diffDays = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function yieldOf(r: Recipe): number {
  return r.items.reduce((s, i) => s + i.grams, 0);
}

interface Demand {
  date: string;
  slot: string;
  recipeSlug: string;
  /** Servings for recipes, grams for components. */
  amount: number;
  leftover: boolean;
}

/**
 * Chooses cook days. Foods that keep (fridge_days of 2 or more) and are eaten more than once close together are
 * batch-cooked on a prep day. Everything else is cooked fresh on the day. A batch never serves a meal that falls after
 * its use-by day, so a plan longer than the fridge life gets top-up sessions automatically.
 */
export function buildPrepGuide(meals: readonly MealRef[], recipes: ReadonlyMap<string, Recipe>, opts: Options): PrepGuide {
  const resolve = resolverFor(opts.partModes);
  const sorted = [...meals].filter((m) => m.servings > 0 && recipes.has(m.recipeSlug)).sort((a, b) => a.date.localeCompare(b.date));

  // Demand per item: recipes by servings, components by grams. Components are expanded recursively, so a component
  // inside a component (a dressing inside a sauce) gets its own cook event and its own night-before tasks.
  const demand = new Map<string, Demand[]>();
  const push = (key: string, d: Demand) => demand.set(key, [...(demand.get(key) ?? []), d]);
  const walk = (r: Recipe, factor: number, meal: MealRef, stack: readonly string[]) => {
    for (const item of r.items) {
      if (!("component" in item) || stack.includes(item.component)) continue;
      // A part that is bought or already made is not cooked, so neither it nor anything inside it needs prep.
      if (!partIsMade(resolve?.(item.component), Boolean(item.alt_ingredient))) continue;
      const sub = recipes.get(item.component);
      if (!sub) continue;
      const grams = item.grams * factor;
      push(`component:${sub.slug}`, { date: meal.date, slot: meal.slot, recipeSlug: meal.recipeSlug, amount: grams, leftover: meal.leftover ?? false });
      walk(sub, grams / Math.max(1, yieldOf(sub)), meal, [...stack, sub.slug]);
    }
  };
  for (const m of sorted) {
    const r = recipes.get(m.recipeSlug)!;
    push(`recipe:${r.slug}`, { date: m.date, slot: m.slot, recipeSlug: m.recipeSlug, amount: m.servings, leftover: m.leftover ?? false });
    walk(r, m.servings / r.servings, m, [r.slug]);
  }

  const sessionDates = new Set<string>();
  const events: CookEvent[] = [];
  const order = [...demand.entries()].sort((a, b) => a[1][0]!.date.localeCompare(b[1][0]!.date) || a[0].localeCompare(b[0]));

  for (const [key, list] of order) {
    const [kind, slug] = key.split(":") as ["recipe" | "component", string];
    const r = recipes.get(slug);
    if (!r) continue;
    const keeps = r.fridge_days >= 2;
    interface Group {
      cook: string | null;
      items: Demand[];
    }
    const groups: Group[] = [];

    if (!keeps) {
      for (const d of list) groups.push({ cook: null, items: [d] });
    } else {
      let current: Group | null = null;
      for (const d of list) {
        if (current?.cook && diffDays(current.cook, d.date) <= r.fridge_days) {
          current.items.push(d);
          continue;
        }
        // Reuse an existing prep day when it still keeps the food fresh; otherwise cook the day before.
        const reuse = [...sessionDates].filter((s) => s <= d.date && diffDays(s, d.date) <= r.fridge_days && s >= opts.earliest).sort().pop();
        const dayBefore = addDays(d.date, -1);
        let cook = reuse ?? (dayBefore < opts.earliest ? opts.earliest : dayBefore);
        if (!reuse && opts.prepDay) {
          // Cook on the chosen weekday when it is not too early for the food to keep and not before cooking is possible.
          const onPrepDay = lastWeekdayOnOrBefore(dayBefore, opts.prepDay);
          if (onPrepDay >= opts.earliest && diffDays(onPrepDay, d.date) <= r.fridge_days) cook = onPrepDay;
        }
        current = { cook, items: [d] };
        groups.push(current);
      }
    }

    for (const group of groups) {
      const g = group.items;
      // One meal means nothing to batch: cook it on the day it is eaten.
      const fresh = !keeps || g.length === 1;
      // Cook once, eat twice: when every later meal in the group is a reheat, the cooking happens on the first meal's day.
      const reheatsOnly = g.length > 1 && !g[0]!.leftover && g.slice(1).every((d) => d.leftover);
      const cookDate = fresh ? g[0]!.date : reheatsOnly ? g[0]!.date : group.cook!;
      if (!fresh) sessionDates.add(cookDate);
      const total = g.reduce((s, d) => s + d.amount, 0);
      const yieldG = kind === "component" ? yieldOf(r) : null;
      const scale = kind === "component" ? Math.max(1, Math.ceil(total / (yieldG ?? 1) - 1e-9)) : total / r.servings;
      const useBy = addDays(cookDate, r.fridge_days);
      const advance: Advance[] = r.advance_prep.map((a, index) => {
        // A lead time of up to 25 hours is the evening before; each further 24 hours is another evening earlier.
        const extraDays = Math.max(0, Math.floor((a.lead_hours - 1) / 24));
        const grams = a.grams ? Math.round(a.grams * scale) : null;
        return { index, instruction: a.instruction, grams, text: `${a.instruction}${grams !== null ? ` (${grams} g)` : ""}`, dueDate: addDays(cookDate, -1 - extraDays) };
      });
      events.push({
        id: `${kind}-${slug}-${cookDate}`,
        kind,
        slug,
        name: r.name,
        cookDate,
        fresh,
        scale,
        servings: kind === "recipe" ? total : r.servings * scale,
        neededG: kind === "component" ? total : null,
        yieldG,
        covers: g.map((d) => ({ date: d.date, slot: d.slot, recipeSlug: d.recipeSlug })),
        useBy,
        activeMin: r.active_min,
        totalMin: r.total_min,
        passiveMin: Math.max(0, r.total_min - r.active_min),
        equipment: r.equipment,
        advance,
      });
    }
  }

  const batch = events.filter((e) => !e.fresh);
  const dates = [...new Set(batch.map((e) => e.cookDate))].sort();
  const sessions: PrepSession[] = dates.map((date) => {
    const evs = batch
      .filter((e) => e.cookDate === date)
      // Long unattended jobs first so they cook while you work on the rest.
      .sort((a, b) => b.passiveMin - a.passiveMin || b.totalMin - a.totalMin || a.name.localeCompare(b.name));
    const activeMin = evs.reduce((s, e) => s + e.activeMin, 0);
    const longest = Math.max(0, ...evs.map((e) => e.totalMin));
    return { date, events: evs, activeMin, wallMin: Math.max(longest, activeMin) + 10, equipment: [...new Set(evs.flatMap((e) => e.equipment))] };
  });

  const nightBefore = events
    .flatMap((e) => e.advance.map((a) => ({ dueDate: a.dueDate, text: a.text, forName: e.name })))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.text.localeCompare(b.text));

  const eventFor = new Map<string, CookEvent>();
  for (const e of events) if (e.kind === "recipe") for (const c of e.covers) eventFor.set(`${c.date}|${c.slot}|${c.recipeSlug}`, e);
  const eat: EatLine[] = sorted.map((m) => {
    const e = eventFor.get(`${m.date}|${m.slot}|${m.recipeSlug}`);
    return {
      date: m.date,
      slot: m.slot,
      recipeSlug: m.recipeSlug,
      mode: e && !e.fresh ? "batch" : "fresh",
      cookDate: e?.cookDate ?? m.date,
      useBy: e?.useBy ?? m.date,
      activeMin: recipes.get(m.recipeSlug)?.active_min ?? 0,
    };
  });

  return { events, sessions, nightBefore, eat };
}
