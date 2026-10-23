import type { Ingredient, Recipe } from "../schemas";
import type { PartModes } from "../parts/mode";
import { partsOf } from "./parts";
import { effectiveMode } from "./timeline";
import type { PartView } from "./timeline";
import { estimateHandsOnMin, HANDS_OFF_SEC, schedule } from "./cookschedule";
import type { CookInput, CookPartInfo, CookStep, CookStepBase, CookTrack } from "./cookschedule";

export { estimateHandsOnMin, HANDS_OFF_SEC, schedule, waitVerb } from "./cookschedule";
export type { CookInput, CookPartInfo, CookStep, CookStepBase, CookTrack } from "./cookschedule";

type RecipeIndex = ReadonlyMap<string, Recipe>;
type IngredientIndex = ReadonlyMap<string, Ingredient>;

function stepsOf(recipe: Recipe): CookStepBase[] {
  return recipe.steps.map((s, index) => ({
    index,
    text: s.text,
    cue: s.cue ?? null,
    tip: s.tip ?? null,
    technique: s.technique ?? null,
    timerSec: s.timer_sec ?? null,
    handsOff: (s.timer_sec ?? 0) >= HANDS_OFF_SEC,
  }));
}

/** "Buy hummus (store-bought)." The name already says store-bought when the ingredient is that. */
export function buyText(name: string): string {
  const lower = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return /store-bought|ready-made|ready made|commercial/i.test(lower) ? `Buy ${lower}.` : `Buy store-bought ${lower}.`;
}

const handsOffTotal = (steps: CookStepBase[]) => steps.filter((s) => s.handsOff).reduce((sum, s) => sum + (s.timerSec ?? 0), 0);

/**
 * Everything cook mode needs to run a meal, as plain data: one track per part being made, one for each bought part
 * (a single "buy" step), and one for the meal's own steps. Parts marked "have" are left out. A part marked "buy" with
 * no store-bought version is made, the same rule the grocery list uses.
 */
export function prepareCook(recipe: Recipe, recipes: RecipeIndex, ingredients: IngredientIndex, partModes: PartModes, servings: number): CookInput {
  const tracks: CookTrack[] = [];
  const parts: CookPartInfo[] = [];
  const seen = new Set<string>();
  let order = 0;

  const walk = (views: PartView[], parentSlug: string | null) => {
    for (const p of views) {
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      const mode = effectiveMode(p, partModes);
      parts.push({ slug: p.slug, name: p.name, label: p.label, parentSlug, mode, keeps: p.keeps, fridgeDays: p.fridgeDays, activeMin: p.activeMin, canToggle: mode === "make" });
      if (mode === "have") continue;
      if (mode === "buy") {
        tracks.push({ slug: p.slug, name: p.name, parentSlug, kind: "buy", keeps: false, activeMin: 0, handsOffSec: 0, order: order++, steps: [{ index: 0, text: buyText(p.altName ?? p.name), cue: null, tip: null, technique: null, timerSec: null, handsOff: false }] });
        continue;
      }
      const raw = recipes.get(p.slug);
      const steps = raw ? stepsOf(raw) : [];
      tracks.push({ slug: p.slug, name: p.name, parentSlug, kind: "make", keeps: p.keeps, activeMin: p.activeMin, handsOffSec: handsOffTotal(steps), order: order++, steps });
      walk(p.children, p.slug);
    }
  };
  walk(partsOf(recipe, recipes, ingredients, servings), null);

  const mealSteps = stepsOf(recipe);
  tracks.push({ slug: null, name: recipe.name, parentSlug: null, kind: "meal", keeps: false, activeMin: recipe.active_min, handsOffSec: handsOffTotal(mealSteps), order: order++, steps: mealSteps });

  return { recipeSlug: recipe.slug, mealName: recipe.name, mealActiveMin: recipe.active_min, tracks, parts };
}

export interface BuildCookPlanOptions {
  /** Parts to skip for this session only ("already made"). */
  alreadyMade?: readonly string[];
}

/** The ordered cook steps across a meal's parts and its own steps. */
export function buildCookPlan(recipe: Recipe, recipes: RecipeIndex, ingredients: IngredientIndex, partModes: PartModes, servings: number, options: BuildCookPlanOptions = {}): CookStep[] {
  return schedule(prepareCook(recipe, recipes, ingredients, partModes, servings), options.alreadyMade ?? []);
}

