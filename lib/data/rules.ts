import type { Habit, Ingredient, Recipe } from "../schemas";

const FORBIDDEN_DIET_TERMS = /\b(chicken|fish|egg|eggs|gelatin|gelatine|beef|pork|lamb|mutton|rennet|prawn|shrimp|anchovy|bacon|ham)\b/i;
const ONION_GARLIC_SLUG = /(^|-)(onion|garlic)(-|$)/;
/** Dry legumes that normally need an overnight soak. Split dals and lentils cook without one. */
const SOAK_LEGUME_SLUGS = new Set([
  "kidney-beans-dry",
  "chickpeas-dry",
  "black-beans-dry",
  "pinto-beans-dry",
  "navy-beans-dry",
  "moong-whole-dry",
  "soybeans-dry",
  "soybean-brown-ifct",
  "kala-chana",
  "horse-gram",
  "moth-bean",
  "lobia-brown-dry",
  "urad-dal-whole-ifct",
]);
const COOKED_STATE_SLUGS_NEED_YIELD_AISLES = new Set(["legumes", "soy-protein"]);

export function dietFlagProblems(ing: Ingredient): string[] {
  const problems: string[] = [];
  for (const text of [ing.slug, ing.name, ...ing.aliases]) {
    if (FORBIDDEN_DIET_TERMS.test(text)) problems.push(`forbidden diet term in "${text}"`);
  }
  if (ONION_GARLIC_SLUG.test(ing.slug) && !ing.contains_onion_garlic) {
    problems.push("onion/garlic ingredient must set contains_onion_garlic");
  }
  if (ing.aisle === "dairy" && !ing.is_dairy) problems.push("dairy aisle ingredient must set is_dairy");
  return problems;
}

export function needsCookedYield(ing: Ingredient, exemptions: Record<string, string>): boolean {
  if (ing.state !== "dry" || ing.cooked_yield !== undefined) return false;
  if (exemptions[ing.slug]) return false;
  return ing.aisle === "grains" || COOKED_STATE_SLUGS_NEED_YIELD_AISLES.has(ing.aisle);
}

/** Dry legumes in a recipe without a matching soak entry in advance_prep. */
export function missingSoak(recipe: Recipe): string[] {
  const soaked = new Set(recipe.advance_prep.filter((p) => p.kind === "soak").map((p) => p.ingredient));
  return recipe.items
    .flatMap((i) => ("ingredient" in i ? [i.ingredient] : []))
    .filter((slug) => SOAK_LEGUME_SLUGS.has(slug) && !soaked.has(slug));
}

/** The weeknight limit applies to the hands-on time on the day, so parts that must be made fresh count (see `effectiveActiveMin`). */
export function weeknightTooLong(recipe: Recipe, recipes?: ReadonlyMap<string, Recipe>): boolean {
  if (recipe.kind !== "recipe") return false;
  return (recipes ? effectiveActiveMin(recipe, recipes) : recipe.active_min) > 20;
}

export function timesInconsistent(recipe: Recipe): boolean {
  return recipe.total_min < recipe.active_min;
}

export function missingTechniqueLinks(recipe: Recipe): boolean {
  return recipe.kind === "recipe" && !recipe.is_indian && !recipe.steps.some((s) => s.technique);
}

/** Technique slugs referenced anywhere in a recipe's steps. */
export function techniqueRefs(recipe: Recipe): string[] {
  return recipe.steps.flatMap((s) => (s.technique ? [s.technique] : []));
}

/** Supplement doses are banned in the data (CLAUDE.md rule 7). Catches mg, mcg, ug, IU and similar. */
const DOSE_PATTERN = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|iu|ml)\b/i;

/** Habit rules from CLAUDE.md rule 7: honest grades, no doses. */
export function habitProblems(h: Habit): string[] {
  const problems: string[] = [];
  if ((h.evidence_grade === "strong" || h.evidence_grade === "moderate") && !h.source_url) {
    problems.push(`${h.evidence_grade} needs a source_url (health authority or human study)`);
  }
  if (h.source_url && !/^https:\/\//.test(h.source_url)) problems.push("source_url must be https");
  for (const text of [h.title, h.evidence_note, h.caution ?? ""]) {
    if (DOSE_PATTERN.test(text)) problems.push(`supplement-style dose in "${text.slice(0, 50)}"`);
  }
  return problems;
}

// ---------- Composite meals (parts) ----------

type RecipeIndex = ReadonlyMap<string, Recipe>;

/** A part that keeps this many days or more can be made ahead of the day it is eaten. */
export const MAKE_AHEAD_DAYS = 2;

function parts(recipe: Recipe, recipes: RecipeIndex): Recipe[] {
  return recipe.items.flatMap((i) => {
    if (!("component" in i)) return [];
    const sub = recipes.get(i.component);
    return sub ? [sub] : [];
  });
}

/** Active minutes of a recipe plus everything its parts need, however far ahead they are made. */
function fullActiveMin(recipe: Recipe, recipes: RecipeIndex, stack: readonly string[]): number {
  if (stack.includes(recipe.slug)) return 0;
  return recipe.active_min + parts(recipe, recipes).reduce((s, p) => s + fullActiveMin(p, recipes, [...stack, recipe.slug]), 0);
}

/**
 * Hands-on minutes on the day: the recipe's own active time plus the parts that must be made fresh because they
 * keep fewer than two days, recursively. Parts that keep longer are make-ahead work (see `makeAheadMin`).
 */
export function effectiveActiveMin(recipe: Recipe, recipes: RecipeIndex, stack: readonly string[] = []): number {
  if (stack.includes(recipe.slug)) return recipe.active_min;
  return (
    recipe.active_min +
    parts(recipe, recipes)
      .filter((p) => p.fridge_days < MAKE_AHEAD_DAYS)
      .reduce((s, p) => s + effectiveActiveMin(p, recipes, [...stack, recipe.slug]), 0)
  );
}

/** Hands-on minutes that can be done days earlier: parts that keep two days or more, with everything inside them. */
export function makeAheadMin(recipe: Recipe, recipes: RecipeIndex): number {
  return parts(recipe, recipes)
    .filter((p) => p.fridge_days >= MAKE_AHEAD_DAYS)
    .reduce((s, p) => s + fullActiveMin(p, recipes, [recipe.slug]), 0);
}

/** Dry legumes anywhere in a recipe, through its parts, with the soaks that cover them. */
function soakScan(recipe: Recipe, recipes: RecipeIndex, stack: readonly string[] = []): { legumes: Set<string>; soaked: Set<string> } {
  const legumes = new Set<string>();
  const soaked = new Set<string>();
  if (stack.includes(recipe.slug)) return { legumes, soaked };
  for (const p of recipe.advance_prep) if (p.kind === "soak" && p.ingredient) soaked.add(p.ingredient);
  for (const i of recipe.items) {
    if ("ingredient" in i) {
      if (SOAK_LEGUME_SLUGS.has(i.ingredient)) legumes.add(i.ingredient);
    } else {
      const sub = recipes.get(i.component);
      if (!sub) continue;
      const inner = soakScan(sub, recipes, [...stack, recipe.slug]);
      inner.legumes.forEach((l) => legumes.add(l));
      inner.soaked.forEach((s) => soaked.add(s));
    }
  }
  return { legumes, soaked };
}

/** Like `missingSoak`, but follows parts: a soak on the recipe or on any of its parts covers the legume. */
export function missingSoakDeep(recipe: Recipe, recipes: RecipeIndex): string[] {
  const { legumes, soaked } = soakScan(recipe, recipes);
  return [...legumes].filter((l) => !soaked.has(l));
}

const OVERLAP_STOP = new Set(["with", "then", "until", "into", "from", "that", "this", "your", "have", "about", "each", "they", "them", "when", "over"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9°]+/)
      .filter((w) => w.length > 3 && !OVERLAP_STOP.has(w)),
  );
}

/** Share of the shorter step's significant words that also appear in the other step, 0 to 1. */
export function stepOverlap(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  const smaller = Math.min(wa.size, wb.size);
  if (smaller < 4) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / smaller;
}

export interface StepRepeat {
  step: number;
  part: string;
  partStep: number;
  overlap: number;
}

/** Steps of a recipe that repeat a step of one of its parts (warning-level: the part's page already says how). */
export function stepsRepeatingParts(recipe: Recipe, recipes: RecipeIndex, threshold = 0.6): StepRepeat[] {
  const out: StepRepeat[] = [];
  for (const sub of parts(recipe, recipes)) {
    recipe.steps.forEach((st, i) => {
      sub.steps.forEach((ps, j) => {
        const overlap = stepOverlap(st.text, ps.text);
        if (overlap >= threshold) out.push({ step: i, part: sub.slug, partStep: j, overlap });
      });
    });
  }
  return out;
}

/** Component steps need a "done when" cue: nobody sees them in the flow of a meal, so they carry their own checks. */
export function componentStepsWithoutCue(recipe: Recipe): number[] {
  if (recipe.kind !== "component") return [];
  return recipe.steps.flatMap((s, i) => (s.cue ? [] : [i]));
}

/**
 * A component earns its own file when it is used by two or more recipes, or has its own method and keeps two days or
 * more, or can be bought instead (some recipe lists an `alt_ingredient` for it).
 */
export function componentJustified(recipe: Recipe, usedBy: number, hasBuyAlternative: boolean): boolean {
  if (recipe.kind !== "component") return true;
  if (usedBy >= 2 || hasBuyAlternative) return true;
  return recipe.steps.length >= 2 && recipe.fridge_days >= MAKE_AHEAD_DAYS;
}

// ---------- Routines (methi water, soaked almonds and similar) ----------

/** Aisles whose items count as seeds, spices or nuts for the routine amount cap. */
export const ROUTINE_CAPPED_AISLES: ReadonlySet<string> = new Set(["spices", "nuts-seeds"]);

/** Amounts and household measures that must not appear in a routine's habit text: a routine is a food, not a dose. */
const ROUTINE_TEXT_PATTERN = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|iu|ml|g|kg|l|oz|tsp|tbsp|cups?)\b|\b(teaspoons?|tablespoons?|tsp|tbsp)\b/i;
/** Volume units that must not appear in a routine's steps: say "a glass of water". */
const ROUTINE_STEP_UNIT_PATTERN = /\b\d+(\.\d+)?\s?(ml|l|litres?|liters?|cups?|tsp|tbsp|teaspoons?|tablespoons?|oz)\b|\b(teaspoons?|tablespoons?|tsp|tbsp|cups?|millilit(?:re|er)s?)\b/i;

/** Extra habit rules for a routine: no amounts or household measures in the evidence note, caution or title. */
export function routineHabitTextProblems(h: Habit): string[] {
  if (!h.routine) return [];
  return [h.title, h.evidence_note, h.caution ?? ""].flatMap((text) => (ROUTINE_TEXT_PATTERN.test(text) ? [`routine text names an amount or measure: "${text.slice(0, 50)}"`] : []));
}

export interface RoutineCaps {
  default: number;
  items: Record<string, number>;
}

/** Rules for one routine recipe. `ingredients` supplies each item's aisle. */
export function routineRecipeProblems(recipe: Recipe, ingredients: ReadonlyMap<string, Ingredient>, caps: RoutineCaps): string[] {
  if (recipe.kind !== "routine") return [];
  const problems: string[] = [];
  for (const item of recipe.items) {
    if (!("ingredient" in item)) {
      problems.push(`routine items must be ingredients, not parts ("${item.component}")`);
      continue;
    }
    const ing = ingredients.get(item.ingredient);
    if (!ing || !ROUTINE_CAPPED_AISLES.has(ing.aisle)) continue;
    const perServing = item.grams / recipe.servings;
    const cap = caps.items[item.ingredient] ?? caps.default;
    if (perServing > cap) problems.push(`${item.ingredient} is ${perServing} g per serving, above the routine cap of ${cap} g (raise it in validation-overrides.json only for a food, never a dose)`);
  }
  recipe.steps.forEach((st, i) => {
    if (!st.cue) problems.push(`step ${i + 1} needs a "done when" cue`);
    for (const text of [st.text, st.cue ?? "", st.tip ?? ""]) {
      if (ROUTINE_STEP_UNIT_PATTERN.test(text)) problems.push(`step ${i + 1} uses a volume unit; say "a glass of water": "${text.slice(0, 50)}"`);
    }
  });
  for (const p of recipe.advance_prep) {
    if (ROUTINE_STEP_UNIT_PATTERN.test(p.instruction)) problems.push(`advance_prep uses a volume unit; say "a glass of water": "${p.instruction.slice(0, 50)}"`);
  }
  const mentionsSoak = recipe.steps.some((s) => /\bsoak/i.test(s.text)) || recipe.advance_prep.some((p) => /\bsoak/i.test(p.instruction));
  if (mentionsSoak && !recipe.advance_prep.some((p) => p.kind === "soak")) problems.push("a routine that soaks needs a soak entry in advance_prep");
  if (recipe.meal_slots.length > 0) problems.push("a routine is not a meal: meal_slots must be empty");
  if (recipe.servings !== 1) problems.push("a routine is one serving (servings must be 1)");
  return problems;
}

/** Every routine recipe is linked from exactly one habit, and every habit's routine points at a routine recipe. */
export function routineLinkProblems(habits: readonly Habit[], recipes: ReadonlyMap<string, Recipe>): string[] {
  const problems: string[] = [];
  const used = new Map<string, string[]>();
  for (const h of habits) {
    if (!h.routine) continue;
    const target = recipes.get(h.routine.recipe);
    if (!target) problems.push(`habit "${h.slug}" points at unknown routine "${h.routine.recipe}"`);
    else if (target.kind !== "routine") problems.push(`habit "${h.slug}" points at "${h.routine.recipe}", which is a ${target.kind}, not a routine`);
    used.set(h.routine.recipe, [...(used.get(h.routine.recipe) ?? []), h.slug]);
    if (new Set(h.routine.default_days).size !== h.routine.default_days.length) problems.push(`habit "${h.slug}" lists a default day twice`);
  }
  for (const r of recipes.values()) {
    if (r.kind !== "routine") continue;
    const by = used.get(r.slug) ?? [];
    if (by.length === 0) problems.push(`routine "${r.slug}" is not linked from any habit`);
    if (by.length > 1) problems.push(`routine "${r.slug}" is linked from ${by.length} habits (${by.join(", ")}); link it from exactly one`);
  }
  return problems;
}
