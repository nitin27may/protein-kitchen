import { defineFilters } from "./index";

export interface RecipeCardData {
  slug: string;
  name: string;
  /** "component" is a part of a meal (hummus, a dressing). Hidden unless "Show parts" is on. */
  kind: "recipe" | "component";
  family: string;
  cuisine: string;
  slots: string[];
  proteinG: number;
  kcal: number;
  activeMin: number;
  isIndian: boolean;
  tags: string[];
  lowSugar: boolean;
  light: boolean;
  dense: boolean;
  image: string | null;
  thumbs: string[];
  favourite: boolean;
  tested: boolean;
  rating: number | null;
  banned: boolean;
}

const density = (r: RecipeCardData) => (r.kcal > 0 ? r.proteinG / r.kcal : 0);

export const recipeFilters = defineFilters<RecipeCardData>({
  search: (r) => [r.name, r.family, r.cuisine, ...r.slots],
  defaultSort: "protein",
  sorts: [
    { value: "protein", label: "Most protein", compare: (a, b) => b.proteinG - a.proteinG || a.name.localeCompare(b.name) },
    { value: "density", label: "Protein per 100 kcal", compare: (a, b) => density(b) - density(a) || a.name.localeCompare(b.name) },
    { value: "fastest", label: "Fastest", compare: (a, b) => a.activeMin - b.activeMin || b.proteinG - a.proteinG },
    { value: "name", label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
  ],
  visible: (r, st) => (!r.banned || st.sel.show?.includes("hidden") === true) && (r.kind === "recipe" || st.sel.show?.includes("parts") === true),
  facets: [
    {
      key: "meal",
      label: "Meal",
      mode: "multi",
      combine: "or",
      options: ["breakfast", "lunch", "dinner", "snack", "shake"].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1), test: (r: RecipeCardData) => r.slots.includes(v) })),
    },
    {
      key: "time",
      label: "Active time",
      mode: "single",
      options: [15, 20, 30].map((m) => ({ value: String(m), label: `${m} min or less`, test: (r: RecipeCardData) => r.activeMin <= m })),
    },
    {
      key: "protein",
      label: "Protein per serving",
      mode: "single",
      options: [20, 30].map((g) => ({ value: String(g), label: `${g} g or more`, test: (r: RecipeCardData) => r.proteinG >= g })),
    },
    {
      key: "cuisine",
      label: "Cuisine",
      mode: "single",
      options: [
        { value: "indian", label: "Indian", test: (r) => r.isIndian },
        { value: "global", label: "Global", test: (r) => !r.isIndian },
      ],
    },
    {
      key: "health",
      label: "Health",
      mode: "multi",
      combine: "and",
      options: [
        { value: "high-protein", label: "High protein", test: (r) => r.tags.includes("high-protein") },
        { value: "nutrient-dense", label: "Nutrient-dense", test: (r) => r.dense },
        { value: "light", label: "Light", test: (r) => r.light },
        { value: "low-sugar", label: "Low sugar", test: (r) => r.lowSugar },
        { value: "high-fibre", label: "High fibre", test: (r) => r.tags.includes("high-fibre") },
      ],
    },
    {
      key: "yours",
      label: "Yours",
      mode: "multi",
      combine: "and",
      options: [
        { value: "favourites", label: "Favourites", test: (r) => r.favourite },
        { value: "tested", label: "Tested", test: (r) => r.tested },
      ],
    },
    {
      key: "show",
      label: "Also show",
      mode: "multi",
      inclusive: true,
      options: [
        { value: "parts", label: "Parts of meals", test: (r) => r.kind === "component" },
        { value: "hidden", label: "Hidden recipes", test: (r) => r.banned },
      ],
    },
  ],
  presets: [
    { id: "weeknight-high-protein", label: "Weeknight high-protein", sel: { time: ["20"], health: ["high-protein"] } },
    { id: "breakfast-20g", label: "Breakfast 20 g+", sel: { meal: ["breakfast"], protein: ["20"] } },
    { id: "tested", label: "Tested", sel: { yours: ["tested"] } },
  ],
});
