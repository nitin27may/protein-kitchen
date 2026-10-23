/**
 * Filtering for the lists that live inside sheets and panels (pin recipes, swap meal, grocery list, ingredient picker).
 * They are small and not worth a URL, so the state is plain data and the functions are pure.
 */

export interface PickRecipe {
  slug: string;
  name: string;
  proteinG: number;
  activeMin: number;
  slots: string[];
}

export type PickSort = "protein" | "fastest" | "name";
export type PickTime = "any" | "15" | "20";

export interface PickState {
  q: string;
  /** Meal type, or "all". */
  meal: string;
  time: PickTime;
  sort: PickSort;
}

export const PICK_DEFAULT: PickState = { q: "", meal: "all", time: "any", sort: "protein" };

export const PICK_SORTS: { value: PickSort; label: string }[] = [
  { value: "protein", label: "Most protein" },
  { value: "fastest", label: "Fastest" },
  { value: "name", label: "Name" },
];

export const PICK_TIMES: { value: PickTime; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "15", label: "15 min or less" },
  { value: "20", label: "20 min or less" },
];

const needle = (q: string) => q.trim().toLowerCase();

export function pickIsFiltered(s: PickState, fixedMeal = false): boolean {
  return s.q.trim() !== "" || (!fixedMeal && s.meal !== "all") || s.time !== "any";
}

export function filterPickRecipes(items: PickRecipe[], s: PickState): PickRecipe[] {
  const n = needle(s.q);
  const max = s.time === "any" ? Infinity : Number(s.time);
  const out = items
    .filter((r) => !n || r.name.toLowerCase().includes(n))
    .filter((r) => s.meal === "all" || r.slots.includes(s.meal))
    .filter((r) => r.activeMin <= max);
  const by: Record<PickSort, (a: PickRecipe, b: PickRecipe) => number> = {
    protein: (a, b) => b.proteinG - a.proteinG || a.name.localeCompare(b.name),
    fastest: (a, b) => a.activeMin - b.activeMin || b.proteinG - a.proteinG || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...out].sort(by[s.sort]);
}

export interface GroceryFilterState {
  q: string;
  hideTicked: boolean;
}

/** Search by item name and optionally hide what is already ticked. Order is kept. */
export function filterGroceryLines<T extends { slug: string; name: string }>(lines: T[], s: GroceryFilterState, isChecked: (slug: string) => boolean): T[] {
  const n = needle(s.q);
  return lines.filter((l) => (!n || l.name.toLowerCase().includes(n)) && (!s.hideTicked || !isChecked(l.slug)));
}

export interface PrefView {
  group: string;
  view: "all" | "like" | "avoid";
  q: string;
}

/** What the picker is currently narrowed by, as removable chips. */
export function pickerChips(s: PrefView): { key: "group" | "view" | "q"; label: string }[] {
  const chips: { key: "group" | "view" | "q"; label: string }[] = [];
  if (s.group !== "All") chips.push({ key: "group", label: s.group });
  if (s.view !== "all") chips.push({ key: "view", label: s.view === "like" ? "Liked only" : "Avoided only" });
  if (s.q.trim()) chips.push({ key: "q", label: `"${s.q.trim()}"` });
  return chips;
}
