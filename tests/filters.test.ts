import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeChips,
  applyFilters,
  applyPreset,
  clearFilters,
  defaultState,
  defineFilters,
  facetCounts,
  hasFilterParams,
  parseFilterParams,
  presetIsActive,
  resolveInitialQuery,
  serializeFilterState,
  toggleOption,
  visibleCount,
} from "../lib/filters";
import { ingredientFilters } from "../lib/filters/ingredients";
import type { IngredientCard } from "../lib/filters/ingredients";
import { recipeFilters } from "../lib/filters/recipes";
import type { RecipeCardData } from "../lib/filters/recipes";
import { openDb } from "../lib/db/client";
import { clearDefaultView, defaultViewQuery, setDefaultView } from "../lib/server/saved-views";

interface Item {
  name: string;
  meal: string;
  min: number;
  veg: boolean;
  spicy: boolean;
}

const items: Item[] = [
  { name: "Rajma masala", meal: "dinner", min: 20, veg: true, spicy: true },
  { name: "Palak paneer", meal: "dinner", min: 30, veg: true, spicy: false },
  { name: "Egg-free omelette", meal: "breakfast", min: 10, veg: true, spicy: false },
  { name: "Fiery chickpea snack", meal: "snack", min: 5, veg: true, spicy: true },
];

const def = defineFilters<Item>({
  search: (i) => [i.name, i.meal],
  defaultSort: "name",
  sorts: [
    { value: "name", label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
    { value: "fast", label: "Fastest", compare: (a, b) => a.min - b.min },
  ],
  facets: [
    { key: "meal", label: "Meal", mode: "multi", combine: "or", options: ["breakfast", "dinner", "snack"].map((m) => ({ value: m, label: m, test: (i: Item) => i.meal === m })) },
    { key: "time", label: "Time", mode: "single", options: [10, 20].map((m) => ({ value: String(m), label: `${m} min`, test: (i: Item) => i.min <= m })) },
    { key: "tags", label: "Tags", mode: "multi", combine: "and", options: [{ value: "spicy", label: "Spicy", test: (i) => i.spicy }, { value: "quick", label: "Quick", test: (i) => i.min <= 20 }] },
  ],
  presets: [{ id: "quick-spicy", label: "Quick and spicy", sel: { tags: ["spicy", "quick"] }, sort: "fast" }],
});

describe("parseFilterParams", () => {
  it("falls back to defaults for an empty or garbage query", () => {
    expect(parseFilterParams(def, "")).toEqual(defaultState(def));
    expect(parseFilterParams(def, "sort=bogus&meal=pizza&time=999&tags=nope,spicy&q=")).toEqual({ q: "", sort: "name", sel: { meal: [], time: [], tags: ["spicy"] } });
  });

  it("keeps only the first value of a single-choice facet and drops duplicates", () => {
    const st = parseFilterParams(def, "time=20,10&meal=dinner,dinner,snack");
    expect(st.sel.time).toEqual(["20"]);
    expect(st.sel.meal).toEqual(["dinner", "snack"]);
  });

  it("accepts a plain object, as Next's searchParams gives", () => {
    expect(parseFilterParams(def, { q: "rajma", meal: "dinner", sort: ["fast"] }).sort).toBe("fast");
  });

  it("round trips through serialize and leaves defaults out of the URL", () => {
    const st = parseFilterParams(def, "q=paneer&sort=fast&meal=dinner,snack&tags=spicy");
    const qs = serializeFilterState(def, st);
    expect(qs).toBe("q=paneer&sort=fast&meal=dinner,snack&tags=spicy");
    expect(parseFilterParams(def, qs)).toEqual(st);
    expect(serializeFilterState(def, defaultState(def))).toBe("");
  });

  it("trims and bounds the search text", () => {
    expect(parseFilterParams(def, `q=${encodeURIComponent("  rajma  ")}`).q).toBe("rajma");
    expect(parseFilterParams(def, `q=${"x".repeat(101)}`).q).toBe("");
  });
});

describe("applyFilters", () => {
  it("needs every search word to match, in any field", () => {
    expect(applyFilters(def, items, { ...defaultState(def), q: "dinner spicy" })).toEqual([]);
    expect(applyFilters(def, items, { ...defaultState(def), q: "dinner rajma" }).map((i) => i.name)).toEqual(["Rajma masala"]);
  });

  it("ORs a multi facet marked or, ANDs one marked and, and sorts", () => {
    const or = applyFilters(def, items, toggleOption(def, toggleOption(def, defaultState(def), "meal", "dinner"), "meal", "snack"));
    expect(or.map((i) => i.name)).toEqual(["Fiery chickpea snack", "Palak paneer", "Rajma masala"]);
    const and = applyFilters(def, items, { ...defaultState(def), sort: "fast", sel: { meal: [], time: [], tags: ["spicy", "quick"] } });
    expect(and.map((i) => i.name)).toEqual(["Fiery chickpea snack", "Rajma masala"]);
  });

  it("replaces a single-choice facet and clears it when chosen again", () => {
    let st = toggleOption(def, defaultState(def), "time", "10");
    st = toggleOption(def, st, "time", "20");
    expect(st.sel.time).toEqual(["20"]);
    expect(toggleOption(def, st, "time", "20").sel.time).toEqual([]);
    expect(toggleOption(def, st, "time", "nope")).toBe(st);
  });
});

describe("facetCounts", () => {
  it("counts each option against everything else that is active, ignoring its own facet", () => {
    const st = toggleOption(def, defaultState(def), "meal", "dinner");
    const c = facetCounts(def, items, st);
    // meal ignores its own selection, so breakfast still shows what it would give
    expect(c.meal).toEqual({ breakfast: 1, dinner: 2, snack: 1 });
    // time respects the dinner filter: only the 20 min rajma is at most 20, none are at most 10
    expect(c.time).toEqual({ "10": 0, "20": 1 });
  });

  it("agrees with applyFilters when an option is chosen", () => {
    const base = toggleOption(def, defaultState(def), "tags", "spicy");
    const counts = facetCounts(def, items, base);
    for (const m of ["breakfast", "dinner", "snack"]) {
      expect(applyFilters(def, items, toggleOption(def, base, "meal", m)).length).toBe(counts.meal![m]);
    }
  });
});

describe("presets", () => {
  it("applies a preset's filters and sort, and recognises it as active", () => {
    const st = applyPreset(def, "quick-spicy", { ...defaultState(def), q: "x" });
    expect(st).toEqual({ q: "x", sort: "fast", sel: { meal: [], time: [], tags: ["spicy", "quick"] } });
    expect(presetIsActive(def, "quick-spicy", st)).toBe(true);
    expect(presetIsActive(def, "quick-spicy", toggleOption(def, st, "meal", "dinner"))).toBe(false);
    expect(presetIsActive(def, "quick-spicy", { ...st, sort: "name" })).toBe(false);
  });

  it("rejects a preset that points at nothing", () => {
    expect(() => defineFilters<Item>({ ...def, presets: [{ id: "bad", label: "Bad", sel: { meal: ["pizza"] } }] })).toThrow();
    expect(() => defineFilters<Item>({ ...def, defaultSort: "nope" })).toThrow();
    expect(() => defineFilters<Item>({ ...def, facets: [...def.facets, def.facets[0]!] })).toThrow();
  });

  it("clearFilters keeps the search and sort", () => {
    const st = clearFilters(def, { q: "a", sort: "fast", sel: { meal: ["dinner"], time: [], tags: [] } });
    expect(st).toEqual({ q: "a", sort: "fast", sel: { meal: [], time: [], tags: [] } });
    expect(activeChips(def, st)).toEqual([]);
  });
});

describe("saved default view", () => {
  it("applies only when the URL says nothing of its own", () => {
    const saved = "meal=dinner&sort=fast";
    expect(resolveInitialQuery(def, "", saved)).toBe(saved);
    expect(resolveInitialQuery(def, "utm_source=x", saved)).toBe(saved);
    expect(resolveInitialQuery(def, "q=rajma", saved)).toBe("q=rajma");
    expect(resolveInitialQuery(def, "time=10", saved)).toBe("time=10");
    expect(resolveInitialQuery(def, "v=0", saved)).toBe("v=0");
    expect(resolveInitialQuery(def, "", null)).toBe("");
    expect(hasFilterParams(def, "v=0")).toBe(true);
    expect(parseFilterParams(def, "v=0")).toEqual(defaultState(def));
  });

  it("keeps exactly one default per list in the database", () => {
    const h = openDb(":memory:", path.resolve(__dirname, "..", "db", "migrations"));
    expect(defaultViewQuery(h.db, "recipes")).toBeNull();
    setDefaultView(h.db, "recipes", "meal=dinner");
    setDefaultView(h.db, "recipes", "time=20&sort=fastest");
    setDefaultView(h.db, "ingredients", "only=high-fibre");
    expect(defaultViewQuery(h.db, "recipes")).toBe("time=20&sort=fastest");
    expect(defaultViewQuery(h.db, "ingredients")).toBe("only=high-fibre");
    clearDefaultView(h.db, "recipes");
    expect(defaultViewQuery(h.db, "recipes")).toBeNull();
    expect(defaultViewQuery(h.db, "ingredients")).toBe("only=high-fibre");
  });
});

const recipe = (over: Partial<RecipeCardData>): RecipeCardData => ({
  slug: "r", name: "Recipe", kind: "recipe", family: "bowls", cuisine: "indian", slots: ["dinner"], proteinG: 25, kcal: 500, activeMin: 20, isIndian: true,
  tags: [], lowSugar: false, light: false, dense: false, image: null, thumbs: [], favourite: false, tested: false, rating: null, banned: false, ...over,
});

describe("recipe filters", () => {
  const list = [
    recipe({ slug: "a", name: "Tofu bowl", proteinG: 32, tags: ["high-protein"], activeMin: 20 }),
    recipe({ slug: "b", name: "Quick oats", slots: ["breakfast"], proteinG: 22, activeMin: 5 }),
    recipe({ slug: "c", name: "Hidden stew", banned: true, proteinG: 40 }),
    recipe({ slug: "d", name: "Hummus", kind: "component", slots: [], proteinG: 3, activeMin: 10 }),
  ];

  it("hides banned recipes and parts until asked, and sorts by protein", () => {
    const d = defaultState(recipeFilters);
    expect(applyFilters(recipeFilters, list, d).map((r) => r.slug)).toEqual(["a", "b"]);
    expect(visibleCount(recipeFilters, list, d)).toBe(2);
    const withBoth = { ...d, sel: { ...d.sel, show: ["parts", "hidden"] } };
    expect(applyFilters(recipeFilters, list, withBoth).map((r) => r.slug)).toEqual(["c", "a", "b", "d"]);
    expect(visibleCount(recipeFilters, list, withBoth)).toBe(4);
  });

  it("counts what showing parts and hidden recipes would add", () => {
    const c = facetCounts(recipeFilters, list, defaultState(recipeFilters));
    expect(c.show).toEqual({ parts: 1, hidden: 1 });
  });

  it("maps the presets to the filters in the plan", () => {
    expect(applyPreset(recipeFilters, "weeknight-high-protein", defaultState(recipeFilters)).sel).toMatchObject({ time: ["20"], health: ["high-protein"] });
    const st = applyPreset(recipeFilters, "breakfast-20g", defaultState(recipeFilters));
    expect(st.sel).toMatchObject({ meal: ["breakfast"], protein: ["20"] });
    expect(applyFilters(recipeFilters, list, st).map((r) => r.slug)).toEqual(["b"]);
    expect(applyPreset(recipeFilters, "tested", defaultState(recipeFilters)).sel.yours).toEqual(["tested"]);
  });
});

describe("ingredient filters", () => {
  const ing = (over: Partial<IngredientCard>): IngredientCard => ({ slug: "x", name: "X", aliases: [], aisle: "legumes", state: "dry", image: null, kcal: 300, proteinG: 24, carbsG: 50, fatG: 1, fibreG: 8, isDairy: false, onionGarlic: false, ...over });
  const defs = ingredientFilters(["legumes", "dairy"]);
  const list = [
    ing({ slug: "moong", name: "Moong", aliases: ["mung bean"] }),
    ing({ slug: "paneer", name: "Paneer", aisle: "dairy", kcal: 300, proteinG: 19, fibreG: 0, isDairy: true }),
    ing({ slug: "garlic", name: "Garlic", aisle: "vegetables", kcal: 150, proteinG: 6, fibreG: 2, onionGarlic: true }),
  ];

  it("searches aliases and applies the protein-dense preset with its sort", () => {
    expect(applyFilters(defs, list, { ...defaultState(defs), q: "mung" }).map((i) => i.slug)).toEqual(["moong"]);
    const st = applyPreset(defs, "protein-dense", defaultState(defs));
    expect(st.sort).toBe("density");
    expect(applyFilters(defs, list, st).map((i) => i.slug)).toEqual(["moong"]);
    expect(presetIsActive(defs, "protein-dense", st)).toBe(true);
    expect(applyPreset(defs, "high-fibre", defaultState(defs)).sort).toBe("fibre");
  });

  it("filters by aisle (any of several) and exclusions", () => {
    const st = toggleOption(defs, toggleOption(defs, defaultState(defs), "aisle", "legumes"), "aisle", "dairy");
    expect(applyFilters(defs, list, st).map((i) => i.slug)).toEqual(["moong", "paneer"]);
    const noDairy = toggleOption(defs, st, "only", "no-dairy");
    expect(applyFilters(defs, list, noDairy).map((i) => i.slug)).toEqual(["moong"]);
  });
});

describe("pin and swap list filters", () => {
  const r = (slug: string, proteinG: number, activeMin: number, slots: string[]): PickRecipe => ({ slug, name: slug, proteinG, activeMin, slots });
  const list = [r("dal", 10, 25, ["lunch", "dinner"]), r("oats", 40, 5, ["breakfast", "snack"]), r("chilla", 22, 15, ["breakfast"]), r("curry", 25, 20, ["dinner"])];

  it("sorts by protein, speed and name", () => {
    expect(filterPickRecipes(list, PICK_DEFAULT).map((x) => x.slug)).toEqual(["oats", "curry", "chilla", "dal"]);
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, sort: "fastest" }).map((x) => x.slug)).toEqual(["oats", "chilla", "curry", "dal"]);
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, sort: "name" }).map((x) => x.slug)).toEqual(["chilla", "curry", "dal", "oats"]);
  });

  it("combines meal, time and search", () => {
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, meal: "breakfast" }).map((x) => x.slug)).toEqual(["oats", "chilla"]);
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, time: "15" }).map((x) => x.slug)).toEqual(["oats", "chilla"]);
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, time: "20" }).map((x) => x.slug)).toEqual(["oats", "curry", "chilla"]);
    expect(filterPickRecipes(list, { ...PICK_DEFAULT, meal: "dinner", q: " CUR " }).map((x) => x.slug)).toEqual(["curry"]);
  });

  it("knows when a list is narrowed, ignoring a meal the sheet fixes itself", () => {
    expect(pickIsFiltered(PICK_DEFAULT)).toBe(false);
    expect(pickIsFiltered({ ...PICK_DEFAULT, meal: "lunch" })).toBe(true);
    expect(pickIsFiltered({ ...PICK_DEFAULT, meal: "lunch" }, true)).toBe(false);
    expect(pickIsFiltered({ ...PICK_DEFAULT, time: "15" }, true)).toBe(true);
  });
});

describe("grocery and picker filters", () => {
  const lines = [{ slug: "paneer", name: "Paneer" }, { slug: "spinach", name: "Spinach" }, { slug: "oats", name: "Rolled oats (dry)" }];
  const ticked = new Set(["spinach"]);

  it("searches by name and hides ticked items without reordering", () => {
    expect(filterGroceryLines(lines, { q: "", hideTicked: false }, (s) => ticked.has(s)).map((l) => l.slug)).toEqual(["paneer", "spinach", "oats"]);
    expect(filterGroceryLines(lines, { q: "", hideTicked: true }, (s) => ticked.has(s)).map((l) => l.slug)).toEqual(["paneer", "oats"]);
    expect(filterGroceryLines(lines, { q: "OAT", hideTicked: true }, (s) => ticked.has(s)).map((l) => l.slug)).toEqual(["oats"]);
    expect(filterGroceryLines(lines, { q: "spin", hideTicked: true }, (s) => ticked.has(s))).toEqual([]);
  });

  it("describes picker narrowing as removable chips", () => {
    expect(pickerChips({ group: "All", view: "all", q: "" })).toEqual([]);
    expect(pickerChips({ group: "Dairy", view: "like", q: " pan " })).toEqual([
      { key: "group", label: "Dairy" },
      { key: "view", label: "Liked only" },
      { key: "q", label: '"pan"' },
    ]);
  });
});

import { filterGroceryLines, filterPickRecipes, PICK_DEFAULT, pickerChips, pickIsFiltered } from "../lib/filters/lists";
import type { PickRecipe } from "../lib/filters/lists";
