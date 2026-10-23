import { aisleLabel } from "../format";
import type { PartModes } from "../parts/mode";
import { buildGroceryList } from "../grocery/aggregate";
import { perServing } from "../nutrition/macros";
import { microsPerServing } from "../nutrition/micros";
import { portionText, servingWeightG } from "../nutrition/portion";
import { qualityPerServing } from "../nutrition/quality";
import { datesBetween, formatDay } from "../planner/dates";
import type { Ingredient, MicrosFile, Recipe } from "../schemas";

/** Everything the three outputs (spreadsheet grid, Excel, PDF) show. Plain data, safe to send to the client. */

export interface ExportPerson {
  id: number;
  name: string;
  proteinTargetG: number;
  kcalTarget: number | null;
}

export interface ExportWeek {
  n: number;
  from: string;
  to: string;
  label: string;
}

/** Nutrient columns shared by meal rows and day rows. A null amount means the source did not report it. */
export const NUTRIENT_KEYS = [
  "kcal", "protein_g", "carbs_g", "fat_g", "satFat_g", "fibre_g", "sugar_g", "freeSugar_g", "sodium_mg",
  "calcium_mg", "iron_mg", "zinc_mg", "magnesium_mg", "potassium_mg", "vitaminC_mg", "b12_ug", "vitaminD_ug", "folate_ug",
] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
export type Nutrients = Record<NutrientKey, number>;

export const NUTRIENT_COLS: { key: NutrientKey; header: string; unit: string; digits: number }[] = [
  { key: "kcal", header: "Energy", unit: "kcal", digits: 0 },
  { key: "protein_g", header: "Protein", unit: "g", digits: 1 },
  { key: "carbs_g", header: "Carbs", unit: "g", digits: 1 },
  { key: "fat_g", header: "Fat", unit: "g", digits: 1 },
  { key: "satFat_g", header: "Sat. fat", unit: "g", digits: 1 },
  { key: "fibre_g", header: "Fibre", unit: "g", digits: 1 },
  { key: "sugar_g", header: "Sugars", unit: "g", digits: 1 },
  { key: "freeSugar_g", header: "Free sugars", unit: "g", digits: 1 },
  { key: "sodium_mg", header: "Sodium", unit: "mg", digits: 0 },
  { key: "calcium_mg", header: "Calcium", unit: "mg", digits: 0 },
  { key: "iron_mg", header: "Iron", unit: "mg", digits: 1 },
  { key: "zinc_mg", header: "Zinc", unit: "mg", digits: 1 },
  { key: "magnesium_mg", header: "Magnesium", unit: "mg", digits: 0 },
  { key: "potassium_mg", header: "Potassium", unit: "mg", digits: 0 },
  { key: "vitaminC_mg", header: "Vitamin C", unit: "mg", digits: 1 },
  { key: "b12_ug", header: "Vitamin B12", unit: "µg", digits: 2 },
  { key: "vitaminD_ug", header: "Vitamin D", unit: "µg", digits: 2 },
  { key: "folate_ug", header: "Folate", unit: "µg DFE", digits: 0 },
];

export interface MealRow extends Nutrients {
  week: number;
  date: string;
  day: string;
  slot: string;
  recipe: string;
  person: string;
  /** What to eat: pieces for countable recipes, grams otherwise. */
  portion: string;
  servings: number;
  weightG: number;
  leftover: boolean;
  /** True when some ingredient had no reported value for a micronutrient, so those columns are lower bounds. */
  partial: boolean;
}

export interface DayRow extends Nutrients {
  week: number;
  date: string;
  day: string;
  person: string;
  proteinTargetG: number;
  proteinPct: number;
  kcalTarget: number | null;
  meals: number;
}

export interface GroceryRow {
  aisle: string;
  item: string;
  state: string;
  /** Grams needed in each week, in week order. */
  weekG: number[];
  needG: number;
  buyG: number;
  packs: number | null;
  packSizeG: number | null;
  where: string;
  pantry: boolean;
  usedIn: string;
}

export interface PlanExport {
  title: string;
  startDate: string;
  endDate: string;
  generatedOn: string;
  weeks: ExportWeek[];
  people: ExportPerson[];
  meals: MealRow[];
  days: DayRow[];
  /** Average per day, per person. */
  averages: DayRow[];
  grocery: GroceryRow[];
  notes: string[];
}

export interface ExportSlot {
  date: string;
  slot: string;
  recipeSlug: string;
  servings: Record<string, number>;
  isLeftover?: boolean;
}

export interface ExportInput {
  startDate: string;
  endDate: string;
  generatedOn: string;
  people: ExportPerson[];
  slots: ExportSlot[];
  recipes: ReadonlyMap<string, Recipe>;
  ingredients: ReadonlyMap<string, Ingredient>;
  micros: MicrosFile;
  /** The plan's part modes. The grocery sheet leaves out parts you already have and swaps in ready-made ones you buy. */
  partModes?: PartModes;
}

const SLOT_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", shake: "Shake" };
const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack", "shake"];
const r1 = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function weeksOf(startDate: string, endDate: string): ExportWeek[] {
  const dates = datesBetween(startDate, endDate);
  const weeks: ExportWeek[] = [];
  for (let i = 0; i < dates.length; i += 7) {
    const from = dates[i]!;
    const to = dates[Math.min(i + 6, dates.length - 1)]!;
    weeks.push({ n: weeks.length + 1, from, to, label: `Week ${weeks.length + 1}` });
  }
  return weeks;
}

interface PerServingNutrients {
  n: Nutrients;
  partial: boolean;
  weightG: number;
}

function perServingNutrients(slug: string, i: ExportInput, cache: Map<string, PerServingNutrients>): PerServingNutrients {
  const hit = cache.get(slug);
  if (hit) return hit;
  const macros = perServing(slug, i.recipes, i.ingredients);
  const q = qualityPerServing(slug, macros, i.recipes, i.ingredients, i.micros);
  const extra = microsPerServing(slug, i.recipes, i.ingredients, i.micros, ["zinc_mg", "vitamin_b12_ug", "vitamin_d_ug"]);
  const get = (k: string) => extra.find((e) => e.key === k)?.amount ?? 0;
  const partial = q.partial || extra.some((e) => e.missingFrom.length > 0);
  const out: PerServingNutrients = {
    n: {
      kcal: macros.kcal,
      protein_g: macros.protein_g,
      carbs_g: macros.carbs_g,
      fat_g: macros.fat_g,
      satFat_g: q.satFatG,
      fibre_g: macros.fibre_g,
      sugar_g: q.totalSugarG,
      freeSugar_g: q.freeSugarG,
      sodium_mg: q.sodiumMg,
      calcium_mg: q.amounts.calcium_mg ?? 0,
      iron_mg: q.amounts.iron_mg ?? 0,
      zinc_mg: get("zinc_mg"),
      magnesium_mg: q.amounts.magnesium_mg ?? 0,
      potassium_mg: q.amounts.potassium_mg ?? 0,
      vitaminC_mg: q.amounts.vitamin_c_mg ?? 0,
      b12_ug: get("vitamin_b12_ug"),
      vitaminD_ug: get("vitamin_d_ug"),
      folate_ug: q.amounts.folate_ug ?? 0,
    },
    partial,
    weightG: servingWeightG(slug, i.recipes, i.ingredients),
  };
  cache.set(slug, out);
  return out;
}

const zero = (): Nutrients => Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Nutrients;

export function buildPlanExport(i: ExportInput): PlanExport {
  const weeks = weeksOf(i.startDate, i.endDate);
  const weekOf = (date: string) => Math.min(weeks.length, Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${i.startDate}T00:00:00Z`)) / 86_400_000 / 7) + 1);
  const cache = new Map<string, PerServingNutrients>();

  const ordered = [...i.slots].sort((a, b) => a.date.localeCompare(b.date) || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  const meals: MealRow[] = [];
  for (const s of ordered) {
    const recipe = i.recipes.get(s.recipeSlug);
    if (!recipe) continue;
    const base = perServingNutrients(s.recipeSlug, i, cache);
    for (const person of i.people) {
      const servings = s.servings[String(person.id)] ?? 0;
      if (servings <= 0) continue;
      const scaled = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, r1(base.n[k] * servings, NUTRIENT_COLS.find((c) => c.key === k)!.digits + 1)])) as Nutrients;
      meals.push({
        week: weekOf(s.date),
        date: s.date,
        day: dayLabel(s.date),
        slot: SLOT_LABEL[s.slot] ?? s.slot,
        recipe: recipe.name,
        person: person.name,
        portion: portionText(servings, base.weightG, recipe.serving_unit).amount,
        servings,
        weightG: Math.round((servings * base.weightG) / 5) * 5,
        leftover: s.isLeftover ?? false,
        partial: base.partial,
        ...scaled,
      });
    }
  }

  const days: DayRow[] = [];
  for (const date of datesBetween(i.startDate, i.endDate)) {
    for (const person of i.people) {
      const rows = meals.filter((m) => m.date === date && m.person === person.name);
      if (!rows.length) continue;
      const total = zero();
      for (const r of rows) for (const k of NUTRIENT_KEYS) total[k] += r[k];
      for (const k of NUTRIENT_KEYS) total[k] = r1(total[k], NUTRIENT_COLS.find((c) => c.key === k)!.digits + 1);
      days.push({
        week: weekOf(date),
        date,
        day: dayLabel(date),
        person: person.name,
        proteinTargetG: person.proteinTargetG,
        proteinPct: Math.round((total.protein_g / person.proteinTargetG) * 100),
        kcalTarget: person.kcalTarget,
        meals: rows.length,
        ...total,
      });
    }
  }

  const averages: DayRow[] = i.people.flatMap((person) => {
    const rows = days.filter((d) => d.person === person.name);
    if (!rows.length) return [];
    const avg = zero();
    for (const k of NUTRIENT_KEYS) avg[k] = r1(rows.reduce((s, r) => s + r[k], 0) / rows.length, NUTRIENT_COLS.find((c) => c.key === k)!.digits);
    return [{ week: 0, date: "", day: "Daily average", person: person.name, proteinTargetG: person.proteinTargetG, proteinPct: Math.round((avg.protein_g / person.proteinTargetG) * 100), kcalTarget: person.kcalTarget, meals: Math.round((rows.reduce((s, r) => s + r.meals, 0) / rows.length) * 10) / 10, ...avg }];
  });

  const mealRefs = (from: string, to: string) =>
    i.slots.filter((s) => s.date >= from && s.date <= to).map((s) => ({ recipeSlug: s.recipeSlug, servings: Object.values(s.servings).reduce((a, b) => a + b, 0) }));
  const whole = buildGroceryList(mealRefs(i.startDate, i.endDate), i.recipes, i.ingredients, i.partModes);
  const perWeek = weeks.map((w) => new Map(buildGroceryList(mealRefs(w.from, w.to), i.recipes, i.ingredients, i.partModes).lines.map((l) => [l.ingredient, l.grams])));
  const grocery: GroceryRow[] = whole.lines.map((l) => {
    const ing = i.ingredients.get(l.ingredient)!;
    return {
      aisle: aisleLabel(l.aisle),
      item: l.name,
      state: l.state,
      weekG: perWeek.map((m) => Math.round(m.get(l.ingredient) ?? 0)),
      needG: Math.round(l.grams),
      buyG: l.buyGrams,
      packs: l.packs,
      packSizeG: ing.pack_size_g,
      where: ing.where_to_buy.join(", "),
      pantry: l.isPantryStaple,
      usedIn: l.recipes.map((s) => i.recipes.get(s)?.name ?? s).join(", "),
    };
  });

  const lastDay = formatDay(i.endDate).long;
  return {
    title: `Meal plan, ${formatDay(i.startDate).long} to ${lastDay}`,
    startDate: i.startDate,
    endDate: i.endDate,
    generatedOn: i.generatedOn,
    weeks,
    people: i.people,
    meals,
    days,
    averages,
    grocery,
    notes: [
      "Nutrition is computed from the Canadian Nutrient File, USDA FoodData Central and IFCT 2017. Values are estimates, not medical advice.",
      "Micronutrient columns are lower bounds where a source did not report a value for an ingredient. Missing values are never counted as zero.",
      "Portions are approximate plate weights. Dry grains and lentils count at their cooked weight. Pieces (rotis, chillas) follow each recipe.",
      "Grocery quantities are raw weights as listed in the recipes. To buy rounds up to whole packs where the pack size is known.",
    ],
  };
}

