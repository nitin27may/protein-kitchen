import type { Macros, Recipe } from "../schemas";

export type AutoTag = "high-protein" | "quick" | "protein-dense" | "high-fibre";

const HIGH_PROTEIN_THRESHOLD: Record<string, number> = {
  breakfast: 20,
  snack: 12,
  shake: 12,
  lunch: 25,
  dinner: 25,
};

/** Tags the validator applies. Authors never write these by hand. */
export function autoTags(recipe: Pick<Recipe, "meal_slots" | "active_min">, perServing: Macros): AutoTag[] {
  const tags: AutoTag[] = [];
  const primary = recipe.meal_slots[0] ?? "dinner";
  if (perServing.protein_g >= (HIGH_PROTEIN_THRESHOLD[primary] ?? 25)) tags.push("high-protein");
  if (recipe.active_min <= 15) tags.push("quick");
  if (perServing.kcal > 0 && (perServing.protein_g / perServing.kcal) * 100 >= 8) tags.push("protein-dense");
  if (perServing.fibre_g >= 8) tags.push("high-fibre");
  return tags;
}
