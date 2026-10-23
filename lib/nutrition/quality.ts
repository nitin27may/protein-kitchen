import { expandRecipe } from "../grocery/aggregate";
import type { Ingredient, MicrosFile, Recipe } from "../schemas";

/**
 * Nutrient quality of a recipe, per serving.
 *
 * The score follows the structure of the Nutrient Rich Foods index (Drewnowski 2009): percent of a daily reference
 * for nutrients to encourage, per 100 kcal and capped at 100 percent each, minus percent of a maximum for nutrients to
 * limit. It is NOT the published NRF9.3: vitamins A and E are replaced by folate because the Indian food tables do not
 * report them, and the reference values below are this app's own, not the published constants.
 */
export const ENCOURAGE: { key: string; label: string; dv: number }[] = [
  { key: "protein_g", label: "Protein", dv: 50 },
  { key: "fibre_g", label: "Fibre", dv: 28 },
  { key: "calcium_mg", label: "Calcium", dv: 1300 },
  { key: "iron_mg", label: "Iron", dv: 18 },
  { key: "magnesium_mg", label: "Magnesium", dv: 420 },
  { key: "potassium_mg", label: "Potassium", dv: 4700 },
  { key: "vitamin_c_mg", label: "Vitamin C", dv: 90 },
  { key: "folate_ug", label: "Folate", dv: 400 },
];

/** Maximums for nutrients to limit. Free sugars: 50 g is 10 percent of a 2,000 kcal day (WHO). Sodium: Health Canada 2,300 mg. */
export const LIMIT: { key: string; label: string; max: number }[] = [
  { key: "sat_fat_g", label: "Saturated fat", max: 20 },
  { key: "free_sugar_g", label: "Free sugars", max: 50 },
  { key: "sodium_mg", label: "Sodium", max: 2300 },
];

/**
 * Ingredients whose sugars count as free sugars: added sugars, syrups and honey (WHO definition), plus dried dates and
 * raisins. WHO exempts whole fruit, but dried fruit is concentrated sugar and in this app it is used to sweeten, so it is
 * counted here. That is stricter than WHO. Fresh fruit and plain milk do not count.
 */
export const FREE_SUGAR_SOURCES = new Set(["sugar-white", "sugar-brown", "honey", "maple-syrup", "jaggery", "molasses-blackstrap", "condensed-milk", "dates-dry", "dates-medjool", "raisins"]);

export interface Quality {
  kcal: number;
  totalSugarG: number;
  freeSugarG: number;
  sodiumMg: number;
  satFatG: number;
  /** Per-serving amounts of the encouraged nutrients that were found in the data. */
  amounts: Record<string, number>;
  /** NRF-style score per 100 kcal. Higher is more nutrient-rich. */
  score: number;
  /** True when some ingredient with a real weight had no reported value for a nutrient used in the score. */
  partial: boolean;
}

interface Macros {
  kcal: number;
  protein_g: number;
  fibre_g: number;
}

export function qualityPerServing(
  slug: string,
  perServing: Macros,
  recipes: ReadonlyMap<string, Recipe>,
  ingredients: ReadonlyMap<string, Ingredient>,
  micros: MicrosFile,
): Quality {
  const servings = recipes.get(slug)?.servings ?? 1;
  const grams = expandRecipe(slug, servings, recipes);
  const amounts: Record<string, number> = { protein_g: perServing.protein_g, fibre_g: perServing.fibre_g };
  let totalSugar = 0;
  let freeSugar = 0;
  let sodium = 0;
  let satFat = 0;
  let partial = false;

  const sum = (key: string, altKey?: string): number => {
    let total = 0;
    for (const [ing, g] of grams) {
      const per = micros[ing]?.per100g;
      const v = per?.[key] ?? (altKey ? per?.[altKey] : undefined);
      if (v === undefined) {
        if (g >= 5) partial = true;
        continue;
      }
      total += (v * g) / 100;
    }
    return total / servings;
  };

  for (const k of ["calcium_mg", "iron_mg", "magnesium_mg", "potassium_mg", "vitamin_c_mg"]) amounts[k] = sum(k);
  amounts.folate_ug = sum("folate_dfe_ug", "folate_total_ug");
  sodium = sum("sodium_mg");
  satFat = sum("sat_fat_g");
  totalSugar = sum("sugars_g");

  for (const [ing, g] of grams) {
    if (!FREE_SUGAR_SOURCES.has(ing)) continue;
    const info = ingredients.get(ing);
    const per = micros[ing]?.per100g.sugars_g ?? info?.per100g.carbs_g ?? 0; // jaggery has no sugar breakdown; its carbohydrate is sugar
    freeSugar += (per * g) / 100 / servings;
  }

  const kcal = perServing.kcal;
  const per100 = (v: number) => (kcal > 0 ? (v / kcal) * 100 : 0);
  const encouraged = ENCOURAGE.reduce((s, n) => s + Math.min(100, (per100(amounts[n.key] ?? 0) / n.dv) * 100), 0);
  const limited =
    (per100(satFat) / LIMIT[0]!.max) * 100 + (per100(freeSugar) / LIMIT[1]!.max) * 100 + (per100(sodium) / LIMIT[2]!.max) * 100;

  return { kcal, totalSugarG: totalSugar, freeSugarG: freeSugar, sodiumMg: sodium, satFatG: satFat, amounts, score: encouraged - limited, partial };
}

export type HealthTag = "low-sugar" | "light" | "nutrient-dense";

/** Free sugars at or under 5 percent of the serving's energy: WHO's lower, conditional tier. */
export function isLowSugar(q: Quality): boolean {
  if (q.kcal <= 0) return true;
  return (q.freeSugarG * 4) / q.kcal <= 0.05;
}

/** Calorie ceilings per serving. These are this app's own definitions, not medical thresholds. */
export const LIGHT_KCAL: Record<string, number> = { snack: 220, shake: 220, breakfast: 400, lunch: 450, dinner: 450 };

export function isLight(q: Quality, primarySlot: string): boolean {
  return q.kcal <= (LIGHT_KCAL[primarySlot] ?? 450);
}

/** Slugs in the top third of the library by score. Relative on purpose: there is no validated absolute cut-off for this score. */
export function nutrientDenseSet(scores: ReadonlyMap<string, number>, share = 1 / 3): Set<string> {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, Math.round(sorted.length * share));
  return new Set(sorted.slice(0, n).map(([slug]) => slug));
}
