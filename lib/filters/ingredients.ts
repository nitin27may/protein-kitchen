import { aisleLabel } from "../format";
import { defineFilters } from "./index";

export interface IngredientCard {
  slug: string;
  name: string;
  aliases: string[];
  aisle: string;
  state: string;
  image: string | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  isDairy: boolean;
  onionGarlic: boolean;
}

/** Protein per 100 kcal, the app's ranking measure. Zero-kcal items rank last. */
export const proteinDensity = (i: IngredientCard) => (i.kcal > 0 ? (i.proteinG / i.kcal) * 100 : 0);

export function ingredientFilters(aisles: string[]) {
  return defineFilters<IngredientCard>({
    search: (i) => [i.name, ...i.aliases],
    defaultSort: "name",
    sorts: [
      { value: "name", label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
      { value: "protein", label: "Protein per 100 g", compare: (a, b) => b.proteinG - a.proteinG || a.name.localeCompare(b.name) },
      { value: "density", label: "Protein per 100 kcal", compare: (a, b) => proteinDensity(b) - proteinDensity(a) || a.name.localeCompare(b.name) },
      { value: "fibre", label: "Fibre per 100 g", compare: (a, b) => b.fibreG - a.fibreG || a.name.localeCompare(b.name) },
      { value: "kcal", label: "Lowest kcal", compare: (a, b) => a.kcal - b.kcal || a.name.localeCompare(b.name) },
    ],
    facets: [
      {
        key: "aisle",
        label: "Aisle",
        mode: "multi",
        combine: "or",
        options: [...aisles].sort((a, b) => aisleLabel(a).localeCompare(aisleLabel(b))).map((a) => ({ value: a, label: aisleLabel(a), test: (i: IngredientCard) => i.aisle === a })),
      },
      {
        key: "only",
        label: "Show only",
        mode: "multi",
        combine: "and",
        options: [
          { value: "high-protein", label: "High protein", test: (i) => proteinDensity(i) >= 8 },
          { value: "high-fibre", label: "High fibre", test: (i) => i.fibreG >= 6 },
          { value: "no-dairy", label: "No dairy", test: (i) => !i.isDairy },
          { value: "no-onion-garlic", label: "No onion or garlic", test: (i) => !i.onionGarlic },
        ],
      },
    ],
    presets: [
      { id: "protein-dense", label: "Protein-dense", sel: { only: ["high-protein"] }, sort: "density" },
      { id: "high-fibre", label: "High fibre", sel: { only: ["high-fibre"] }, sort: "fibre" },
    ],
  });
}
