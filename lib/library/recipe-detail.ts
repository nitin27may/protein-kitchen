import type { DetailItem, DetailProps } from "@/components/RecipeDetail";
import type { DataSet } from "@/lib/data/load";
import { effectiveActiveMin, makeAheadMin } from "@/lib/data/rules";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { TARGETS, targetFor } from "@/lib/nutrition/dri";
import { anchorIngredients, perServing } from "@/lib/nutrition/macros";
import { microsPerServing } from "@/lib/nutrition/micros";
import { isLight, isLowSugar, qualityPerServing } from "@/lib/nutrition/quality";
import { autoTags } from "@/lib/nutrition/tags";
import { partsOf, usedIn } from "@/lib/recipes/parts";
import { storageAdvice } from "@/lib/recipes/storage";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { displayName } from "@/lib/schemas";

/** Household-owned parts of the recipe page. A library-only page never has them. */
export type RecipeDetailHousehold = Pick<DetailProps, "image" | "photos" | "feedback" | "earlierFeedback" | "partModes" | "planId" | "links">;

/**
 * Everything on a recipe page that comes from the library files: nutrition, method, parts, techniques.
 * No database access, so a visitor without an account can use it. The caller adds the household parts.
 */
export function recipeDetailFromLibrary(
  data: DataSet,
  slug: string,
  opts: { sex: "male" | "female" | "other"; targetLabel: string; ingredientPhotos: ReadonlyMap<string, string>; dense: boolean },
): Omit<DetailProps, keyof RecipeDetailHousehold | "mode"> {
  const r = data.recipes.get(slug)!;
  const m = perServing(slug, data.recipes, data.ingredients);
  const dn = (k: string) => {
    const ing = data.ingredients.get(k);
    return ing ? displayName(ing) : k;
  };
  const items: DetailItem[] = r.items.map((it) => {
    if ("ingredient" in it) {
      const ing = data.ingredients.get(it.ingredient);
      return { kind: "ingredient", name: ing ? displayName(ing) : it.ingredient, state: ing?.state, image: opts.ingredientPhotos.get(it.ingredient) ?? null, aisle: ing?.aisle, grams: it.grams };
    }
    const sub = data.recipes.get(it.component)!;
    const yieldG = sub.items.reduce((a, b) => a + b.grams, 0);
    const parts = [...expandRecipe(it.component, (it.grams * sub.servings) / yieldG, data.recipes)].map(([k, g]) => ({
      name: dn(k),
      state: data.ingredients.get(k)?.state ?? "ready",
      grams: g,
    }));
    return { kind: "component", name: sub.name, grams: it.grams, parts };
  });

  const keys = TARGETS.filter((t) => t.key !== "fibre_g").map((t) => t.key);
  const micro = microsPerServing(slug, data.recipes, data.ingredients, data.micros, keys);
  const nutrients: DetailProps["nutrients"] = [
    { label: "Fibre", unit: "g", amount: m.fibre_g, target: targetFor("fibre_g", opts.sex) ?? null, partial: false },
    ...micro
      .filter((n) => n.amount > 0 || n.missingFrom.length === 0)
      .map((n) => {
        const t = TARGETS.find((x) => x.key === n.key)!;
        return { label: t.label, unit: t.unit, amount: n.amount, target: targetFor(n.key, opts.sex) ?? null, partial: n.missingFrom.length > 0 };
      }),
  ];
  const quality = qualityPerServing(slug, m, data.recipes, data.ingredients, data.micros);
  const techniqueRefs = r.steps.map((s) => s.technique).filter((t): t is string => !!t);
  return {
    slug,
    name: r.name,
    thumbs: recipeThumbs(slug, data.recipes, data.ingredients, opts.ingredientPhotos),
    baseServings: r.servings,
    prepMin: r.prep_min,
    activeMin: r.active_min,
    totalMin: r.total_min,
    fridgeDays: r.fridge_days,
    equipment: r.equipment,
    cuisine: r.cuisine.replace(/-/g, " "),
    macros: { protein: m.protein_g, kcal: m.kcal, carbs: m.carbs_g, fat: m.fat_g, fibre: m.fibre_g },
    tags: autoTags(r, m, effectiveActiveMin(r, data.recipes)),
    anchors: anchorIngredients(slug, data.recipes, data.ingredients).map((a) => dn(a)),
    items,
    advancePrep: r.advance_prep.map((a) => ({ text: `${a.instruction}${a.grams ? ` (${a.grams} g)` : ""}, about ${a.lead_hours} hours ahead` })),
    steps: r.steps.map((s) => {
      const t = s.technique ? data.techniques.get(s.technique) : undefined;
      return { text: s.text, cue: s.cue ?? null, tip: s.tip ?? null, timerSec: s.timer_sec ?? null, technique: s.technique && t ? { slug: s.technique, title: t.title, body: t.body } : null };
    }),
    storage: storageAdvice(r),
    nutrients,
    quality: { freeSugarG: quality.freeSugarG, totalSugarG: quality.totalSugarG, sodiumMg: quality.sodiumMg, satFatG: quality.satFatG, kcal: quality.kcal, score: quality.score, partial: quality.partial, lowSugar: isLowSugar(quality), light: isLight(quality, r.meal_slots[0] ?? "dinner"), dense: opts.dense },
    targetFor: opts.targetLabel,
    techniques: [...new Set(techniqueRefs)].map((t) => ({ slug: t, title: data.techniques.get(t)?.title ?? t })),
    kind: r.kind === "component" ? "component" : "recipe",
    parts: partsOf(r, data.recipes, data.ingredients, r.servings),
    makeAheadMin: makeAheadMin(r, data.recipes),
    mealAdvancePrep: r.advance_prep.map((a) => ({ leadHours: a.lead_hours, instruction: a.instruction })),
    usedIn: r.kind === "component" ? usedIn(slug, data.recipes) : [],
  };
}
