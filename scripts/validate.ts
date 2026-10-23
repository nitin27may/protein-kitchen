import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "../lib/data/load";
import { displayName } from "../lib/schemas";
import {
  componentJustified,
  componentStepsWithoutCue,
  dietFlagProblems,
  effectiveActiveMin,
  habitProblems,
  makeAheadMin,
  missingSoakDeep,
  missingTechniqueLinks,
  needsCookedYield,
  stepsRepeatingParts,
  techniqueRefs,
  timesInconsistent,
  weeknightTooLong,
} from "../lib/data/rules";
import { anchorIngredients, CycleError, kcalDeviationOk, perServing, recipeTotals, UnknownReferenceError } from "../lib/nutrition/macros";
import type { RecipeTotals } from "../lib/nutrition/macros";
import { autoTags } from "../lib/nutrition/tags";
import { isLight, isLowSugar, nutrientDenseSet, qualityPerServing } from "../lib/nutrition/quality";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = loadData(root);
const errors: string[] = data.issues.map((i) => `${i.file}: ${i.message}`);
const warnings: string[] = [];

// Ingredients
for (const [slug, ing] of data.ingredients) {
  const file = data.ingredientFiles.get(slug) ?? slug;
  const expectedFile = `data/ingredients/${ing.aisle}.json`;
  if (file !== expectedFile) errors.push(`${file}: ingredient "${slug}" has aisle "${ing.aisle}" but lives in the wrong file`);
  const p = ing.per100g;
  if (p.protein_g + p.carbs_g + p.fat_g > 100.5) errors.push(`${file}: ${slug} protein+carbs+fat exceeds 100 g per 100 g`);
  if (!data.overrides.kcal_check_skip[slug] && !kcalDeviationOk(p)) errors.push(`${file}: ${slug} kcal ${p.kcal} disagrees with its macros`);
  if (needsCookedYield(ing, data.overrides.dry_without_cooked_yield)) errors.push(`${file}: ${slug} is dry and needs cooked_yield`);
  for (const problem of dietFlagProblems(ing)) errors.push(`${file}: ${slug}: ${problem}`);
  if (!data.micros[slug]) warnings.push(`micros.json: no entry for ingredient "${slug}"`);
  if (!ing.note) warnings.push(`data/ingredient-notes.json: no note for ingredient "${slug}"`);
}
const seenNames = new Map<string, string>();
for (const [slug, ing] of data.ingredients) {
  const shown = displayName(ing).toLowerCase();
  const prior = seenNames.get(shown);
  if (prior) errors.push(`data/ingredients: "${displayName(ing)}" is the display name of both ${prior} and ${slug}`);
  seenNames.set(shown, slug);
  if (!ing.display_name && (ing.name.length > 34 || /M\.F\.|\d%/.test(ing.name))) warnings.push(`data/ingredients: ${slug} has a long source name and no display_name`);
}
for (const slug of Object.keys(data.micros)) {
  if (!data.ingredients.has(slug)) errors.push(`micros.json: entry "${slug}" has no ingredient`);
}
for (const slug of Object.keys(data.overrides.kcal_check_skip)) {
  if (!data.ingredients.has(slug)) warnings.push(`validation-overrides.json: kcal skip for unknown ingredient "${slug}"`);
}

// Habits
const habitSlugs = new Set<string>();
for (const h of data.habits) {
  if (habitSlugs.has(h.slug)) errors.push(`data/habits.json: duplicate slug "${h.slug}"`);
  habitSlugs.add(h.slug);
  for (const p of habitProblems(h)) errors.push(`data/habits.json: ${h.slug}: ${p}`);
}

// Recipes
const memo = new Map<string, RecipeTotals>();
const COOKING = /\b(fry|cook|bake|roast|simmer|boil|steam|sear|saut\w*|toast|blanch|whistles?|air fry|pressure cook|warm|heat)\b/i;
let cookingSteps = 0;
let cookingWithCue = 0;
const rows: string[][] = [];
const qualities = new Map<string, { q: ReturnType<typeof qualityPerServing>; slot: string }>();
const componentUse = new Map<string, number>();
/** Components that some recipe can stand in a ready-made ingredient for. */
const buyAlternatives = new Set<string>();
for (const [slug, recipe] of data.recipes) {
  const file = data.recipeFiles.get(slug) ?? slug;
  for (const item of recipe.items) {
    if ("ingredient" in item && !data.ingredients.has(item.ingredient)) errors.push(`${file}: unknown ingredient "${item.ingredient}"`);
    if ("component" in item) {
      const target = data.recipes.get(item.component);
      if (!target) errors.push(`${file}: unknown component "${item.component}"`);
      else if (target.kind !== "component") errors.push(`${file}: "${item.component}" is a recipe, not a component`);
      else if (recipe.kind === "recipe") componentUse.set(item.component, (componentUse.get(item.component) ?? 0) + 1);
      if (item.alt_ingredient) {
        const alt = data.ingredients.get(item.alt_ingredient);
        if (!alt) errors.push(`${file}: alt_ingredient "${item.alt_ingredient}" on "${item.component}" is not an ingredient`);
        else if (alt.state !== "ready") errors.push(`${file}: alt_ingredient "${item.alt_ingredient}" must be a ready-state ingredient, not ${alt.state}`);
        buyAlternatives.add(item.component);
      }
    }
  }
  for (const prep of recipe.advance_prep) {
    if (prep.ingredient && !data.ingredients.has(prep.ingredient)) errors.push(`${file}: advance_prep references unknown ingredient "${prep.ingredient}"`);
  }
  if (recipe.image && !fs.existsSync(path.join(root, "public", "recipe-images", recipe.image))) {
    errors.push(`${file}: image "${recipe.image}" is not in public/recipe-images`);
  }
  if (recipe.kind === "recipe") {
    for (const st of recipe.steps) {
      if (!COOKING.test(st.text)) continue;
      cookingSteps++;
      if (st.cue) cookingWithCue++;
    }
  }
  for (const t of techniqueRefs(recipe)) {
    if (!data.techniques.has(t)) errors.push(`${file}: unknown technique "${t}"`);
  }
  if (missingTechniqueLinks(recipe)) errors.push(`${file}: non-Indian recipe must link at least one technique card`);
  if (timesInconsistent(recipe)) errors.push(`${file}: total_min is less than active_min`);
  if (recipe.status !== "draft" && recipe.rating === undefined) warnings.push(`${file}: status "${recipe.status}" is set by a human only`);
  for (const ing of missingSoakDeep(recipe, data.recipes)) warnings.push(`${file}: uses dry ${ing} (directly or in a part) without a soak entry in advance_prep`);
  if (weeknightTooLong(recipe, data.recipes)) {
    warnings.push(`${file}: effective active time ${effectiveActiveMin(recipe, data.recipes)} min (own ${recipe.active_min} min) is above the 20 minute weeknight limit`);
  }
  for (const i of componentStepsWithoutCue(recipe)) errors.push(`${file}: component step ${i + 1} needs a "done when" cue`);
  for (const r of stepsRepeatingParts(recipe, data.recipes)) {
    warnings.push(`${file}: step ${r.step + 1} repeats step ${r.partStep + 1} of its part "${r.part}" (${Math.round(r.overlap * 100)}% of words); point to the part instead`);
  }
  if (recipe.tags.some((t) => ["high-protein", "quick", "protein-dense", "high-fibre"].includes(t))) {
    errors.push(`${file}: auto-tags must not be hand-written`);
  }

  try {
    const m = perServing(slug, data.recipes, data.ingredients, memo);
    if (recipe.kind === "recipe") {
      // Snacks and shakes may be light on purpose, so their floor is lower than a meal's.
      const floor = recipe.meal_slots.every((s) => s === "snack" || s === "shake") ? 50 : 150;
      if (m.kcal < floor || m.kcal > 900) warnings.push(`${file}: ${m.kcal.toFixed(0)} kcal per serving looks implausible`);
      const tags = autoTags(recipe, m);
      const q = qualityPerServing(slug, m, data.recipes, data.ingredients, data.micros);
      qualities.set(slug, { q, slot: recipe.meal_slots[0] ?? "dinner" });
      rows.push([
        slug,
        String(recipe.servings),
        m.protein_g.toFixed(1),
        m.kcal.toFixed(0),
        m.carbs_g.toFixed(0),
        m.fat_g.toFixed(0),
        m.fibre_g.toFixed(1),
        ((m.protein_g / m.kcal) * 100).toFixed(1),
        tags.join(","),
        anchorIngredients(slug, data.recipes, data.ingredients).join(","),
        String(recipe.active_min),
        String(effectiveActiveMin(recipe, data.recipes)),
        String(makeAheadMin(recipe, data.recipes)),
      ]);
    }
  } catch (e) {
    if (e instanceof CycleError || e instanceof UnknownReferenceError) errors.push(`${file}: ${e.message}`);
    else throw e;
  }
  void recipeTotals;
}
for (const [slug, recipe] of data.recipes) {
  if (recipe.kind === "component" && !componentJustified(recipe, componentUse.get(slug) ?? 0, buyAlternatives.has(slug))) {
    warnings.push(`${data.recipeFiles.get(slug)}: component "${slug}" is used by fewer than 2 recipes, has no buy alternative, and does not keep 2 days with its own method; fold it into its recipe`);
  }
}

// Health tags: low added sugar, light, nutrient-dense (top third by score).
const dense = nutrientDenseSet(new Map([...qualities].map(([k, v]) => [k, v.q.score])));
for (const row of rows) {
  const entry = qualities.get(row[0]!);
  if (!entry) continue;
  const tags = [isLowSugar(entry.q) ? "low-sugar" : "", isLight(entry.q, entry.slot) ? "light" : "", dense.has(row[0]!) ? "nutrient-dense" : ""].filter(Boolean);
  row.push(entry.q.freeSugarG.toFixed(1), entry.q.score.toFixed(0), tags.join(","));
}

// Report
const header = ["recipe", "srv", "prot g", "kcal", "carb", "fat", "fibre", "p/100kcal", "auto-tags", "anchors", "min own", "min eff", "ahead min", "free sug g", "NRF-style", "health tags"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
console.log(`Ingredients: ${data.ingredients.size}  Recipes+components: ${data.recipes.size}  Techniques: ${data.techniques.size}  Habits: ${data.habits.length}\n`);
console.log(fmt(header));
for (const r of rows.sort((a, b) => Number(b[2]) - Number(a[2]))) console.log(fmt(r));
console.log(`Cooking steps with a "done when" cue: ${cookingWithCue} of ${cookingSteps}`);
if (warnings.length) console.log(`\nWarnings (${warnings.length}):\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
if (errors.length) {
  console.log(`\nErrors (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log("\nvalidate: OK");
