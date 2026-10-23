import type { Recipe } from "../schemas";
import { buildPrepGuide } from "./session";
import type { MealRef, PrepGuide } from "./session";

/**
 * The one source of night-before tasks. Today, the meal prep guide and the 21:00 reminder all call this, so a task has
 * the same text, due evening and key everywhere and ticking it in one place ticks it in all of them.
 */

export type TaskSource = "recipe" | "component" | "routine";

export interface NightTask {
  /** `night:{planId}:{dueDate}:{source}:{slug}:{index}`. No instruction text, so editing a recipe never resets a tick. */
  key: string;
  /** The evening this must be done. */
  dueDate: string;
  /** What to do, with the weight for this cook when the recipe gives one. */
  text: string;
  /** The recipe or component the task is for. */
  forName: string;
  source: TaskSource;
  slug: string;
  /** Position in that recipe's `advance_prep`. */
  index: number;
  /** The day the food is cooked, and the meals it covers. Used to map ticks from older key formats. */
  cookDate: string;
  coverDates: string[];
}

/**
 * Extension point for PR 8 (daily routines such as soaked methi water). A routine is a small recipe scheduled on certain
 * days; its `advance_prep` becomes night-before tasks the evening before each scheduled morning. Not implemented yet:
 * `nightTasks` accepts the input so callers do not change later, and ignores it.
 */
export interface RoutineInput {
  recipeSlug: string;
  /** Mornings the routine is eaten or drunk, as ISO dates. */
  dates: string[];
  servings: number;
}

export interface NightInput {
  planId: number;
  meals: readonly MealRef[];
  recipes: ReadonlyMap<string, Recipe>;
  /** Nothing can be cooked before this date, usually today. */
  earliest: string;
  routines?: readonly RoutineInput[];
}

export const nightKey = (planId: number, dueDate: string, source: TaskSource, slug: string, index: number): string => `night:${planId}:${dueDate}:${source}:${slug}:${index}`;

export interface NightResult {
  guide: PrepGuide;
  tasks: NightTask[];
}

export function buildNight(input: NightInput): NightResult {
  const guide = buildPrepGuide(input.meals, input.recipes, { earliest: input.earliest });
  const byKey = new Map<string, NightTask & { grams: number | null; instruction: string; cooks: number }>();

  for (const e of guide.events) {
    for (const a of e.advance) {
      const key = nightKey(input.planId, a.dueDate, e.kind, e.slug, a.index);
      const found = byKey.get(key);
      if (found) {
        // Two cooks of the same thing on the same day (lunch and dinner both fresh) share one soak: add the weights.
        found.grams = a.grams === null && found.grams === null ? null : (found.grams ?? 0) + (a.grams ?? 0);
        found.coverDates = [...new Set([...found.coverDates, ...e.covers.map((c) => c.date)])].sort();
        found.cooks++;
        continue;
      }
      byKey.set(key, {
        key,
        dueDate: a.dueDate,
        text: "",
        forName: e.name,
        source: e.kind,
        slug: e.slug,
        index: a.index,
        cookDate: e.cookDate,
        coverDates: [...new Set(e.covers.map((c) => c.date))].sort(),
        grams: a.grams,
        instruction: a.instruction,
        cooks: 1,
      });
    }
  }

  const tasks: NightTask[] = [...byKey.values()]
    .map(({ grams, instruction, cooks: _cooks, ...t }) => ({ ...t, text: `${instruction}${grams !== null ? ` (${grams} g)` : ""}` }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.text.localeCompare(b.text) || a.key.localeCompare(b.key));
  return { guide, tasks };
}

export function nightTasks(input: NightInput): NightTask[] {
  return buildNight(input).tasks;
}

/** The due evening encoded in a current-format key, or null for any other key. */
export const dueDateOfKey = (key: string): string | null => /^night:\d+:(\d{4}-\d{2}-\d{2}):(?:recipe|component|routine):/.exec(key)?.[1] ?? null;

/** Tasks to do on one evening. */
export const tasksDueOn = (tasks: readonly NightTask[], date: string): NightTask[] => tasks.filter((t) => t.dueDate === date);

// ---------- Tick migration ----------

const NEW_KEY = /^night:\d+:\d{4}-\d{2}-\d{2}:(recipe|component|routine):/;
/** Today's old key: `{mealDate}:{recipeSlug}:{adviceIndex}`. */
const OLD_TODAY_KEY = /^(\d{4}-\d{2}-\d{2}):([a-z0-9-]+):(\d+)$/;
/** The prep page's old key: `night:{planId}:{dueDate}:{position}:{text}`, cut at 180 characters. */
const OLD_PAGE_KEY = /^night:(\d+):(\d{4}-\d{2}-\d{2}):(\d+):(.*)$/s;

export type KeyMigration = { action: "keep" } | { action: "rename"; key: string; date: string } | { action: "drop" };

/**
 * Maps one stored tick key to the current format.
 *
 * Old keys carried either a meal date and a recipe slug (Today) or the instruction text itself (prep page). They are
 * matched against the tasks the plan produces now. A tick that cannot be matched, because the recipe, its wording or
 * the cooking day changed since it was saved, is dropped: the task simply shows as not done again. That loss is accepted
 * for a one-person app and happens once.
 *
 * Idempotent: a key already in the new format is kept as is, and new keys are never produced from new keys.
 */
export function migrateTickKey(oldKey: string, ctx: { planId: number; tasks: readonly NightTask[] }): KeyMigration {
  if (NEW_KEY.test(oldKey)) return { action: "keep" };

  const page = OLD_PAGE_KEY.exec(oldKey);
  if (page) {
    if (Number(page[1]) !== ctx.planId) return { action: "keep" };
    const [, , dueDate, , text] = page;
    const hit = ctx.tasks.find((t) => t.dueDate === dueDate && t.text.startsWith(text!));
    return hit ? { action: "rename", key: hit.key, date: hit.dueDate } : { action: "drop" };
  }

  const today = OLD_TODAY_KEY.exec(oldKey);
  if (today) {
    const [, mealDate, slug, idx] = today;
    const hit = ctx.tasks.find((t) => t.source === "recipe" && t.slug === slug && t.index === Number(idx) && (t.cookDate === mealDate || t.coverDates.includes(mealDate!)));
    return hit ? { action: "rename", key: hit.key, date: hit.dueDate } : { action: "drop" };
  }

  // Anything else (for example `prep:{planId}:{eventId}` batch-cook ticks) is not ours.
  return { action: "keep" };
}
