import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadData, type DataSet } from "../lib/data/load";
import { applyFilters, defaultState, searchScore } from "../lib/filters";
import { anonymousRecipeFilters, recipeFilters } from "../lib/filters/recipes";
import { ingredientFilters } from "../lib/filters/ingredients";
import { libraryHighlights, libraryIngredientCards, libraryIngredientDetail, libraryRecipeCards, libraryRecipeDetail } from "../lib/library/anonymous";
import { perServing } from "../lib/nutrition/macros";
import { displayName } from "../lib/schemas";
import { AnonymousHome } from "../components/AnonymousHome";
import { IngredientDetailView } from "../components/IngredientDetailView";
import { IngredientsClient } from "../components/IngredientsClient";
import { RecipeDetail } from "../components/RecipeDetail";
import { RecipesClient } from "../components/RecipesClient";

let query = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(query),
  usePathname: () => "/recipes",
}));
const denied = vi.hoisted(() => () => { throw new Error("A library page must not call a household action."); });
vi.mock("../app/actions", () => ({
  saveDefaultView: denied, clearDefaultView: denied, setRecipeFeedback: denied, setPartMode: denied,
  moveLink: denied, removeLink: denied, makeCoverPhoto: denied, removePhoto: denied,
}));
vi.mock("../lib/server/context", () => ({
  getDb: () => { throw new Error("Public rendering must not open the household database."); },
}));

let data: DataSet;
beforeAll(() => { data = loadData(process.cwd()); });
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
// Controls (Favourite, Add a link, Save as my default) are visible to visitors on purpose and ask for an email; only data must not appear.
const PRIVATE = /\/photos\/|Earlier household|male values|female values|Synthetic|Draft: not cooked yet/;

describe("library loaders", () => {
  it("list meals and parts but not routines, with no household state", () => {
    const cards = libraryRecipeCards(data);
    const slugs = new Set(cards.map((c) => c.slug));
    for (const r of data.recipes.values()) expect(slugs.has(r.slug)).toBe(r.kind !== "routine");
    for (const c of cards) {
      expect([c.favourite, c.tested, c.banned, c.rating, c.image]).toEqual([false, false, false, null, null]);
      expect(c.thumbs).toEqual([]);
    }
    expect(cards.filter((c) => c.kind === "component").length).toBeGreaterThan(0);
    expect(libraryIngredientCards(data)).toHaveLength(data.ingredients.size);
  });

  it("compute macros from the ingredient data", () => {
    const card = libraryRecipeCards(data).find((c) => c.slug === "tofu-burrito-bowl")!;
    expect(card.proteinG).toBeCloseTo(perServing("tofu-burrito-bowl", data.recipes, data.ingredients).protein_g, 6);
  });

  it("return no detail for routines and unknown slugs", () => {
    expect(libraryRecipeDetail(data, "methi-water")).toBeNull();
    expect(libraryRecipeDetail(data, "no-such-recipe")).toBeNull();
    expect(libraryHighlights(data, 6)).toHaveLength(6);
  });
});

describe("search", () => {
  const cards = () => libraryRecipeCards(data);
  const find = (q: string) => applyFilters(anonymousRecipeFilters, cards(), { ...defaultState(anonymousRecipeFilters), q }).map((c) => c.slug);

  it("matches name, cuisine, tags and ingredient names, case-insensitively", () => {
    expect(find("  TOFU BURRITO  ")[0]).toBe("tofu-burrito-bowl");
    expect(find("mexican")).toContain("tofu-burrito-bowl");
    expect(find("high-protein").length).toBeGreaterThan(0);
    expect(find("high protein")).toEqual(find("high-protein"));
    const withTofu = cards().filter((c) => c.keywords?.some((k) => /tofu/i.test(k)) && c.kind === "recipe").map((c) => c.slug);
    expect(withTofu.length).toBeGreaterThan(1);
    for (const slug of withTofu) expect(find("tofu")).toContain(slug);
    expect(find("NoSuchLibraryRecipe")).toEqual([]);
  });

  it("ranks a name match above an ingredient-only match and a word above a fragment", () => {
    const named = find("tofu").findIndex((s) => /tofu/.test(s));
    const ingredientOnly = find("tofu").findIndex((s) => !/tofu/.test(s));
    expect(named).toBeGreaterThanOrEqual(0);
    if (ingredientOnly >= 0) expect(named).toBeLessThan(ingredientOnly);
    const item = (name: string) => ({ name });
    const def = { search: (i: { name: string }) => [i.name], sorts: [], defaultSort: "", facets: [], presets: [] };
    expect(searchScore(def, item("Pea soup"), "pea")!).toBeGreaterThan(searchScore(def, item("Chickpea salad"), "pea")!);
    expect(searchScore(def, item("Tomato soup"), "tomatoes")).not.toBeNull();
    expect(searchScore(def, item("Crème brûlée"), "creme")).not.toBeNull();
    expect(searchScore(def, item("Rajma"), "rajma")!).toBeGreaterThan(searchScore(def, item("Rajma masala"), "rajma")!);
    expect(searchScore(def, item("Rajma masala"), "rajma dinner")).toBeNull();
  });

  it("searches ingredient aliases", () => {
    const withAlias = [...data.ingredients.values()].find((i) => i.aliases.length)!;
    const def = ingredientFilters([...new Set([...data.ingredients.values()].map((i) => i.aisle))]);
    const found = applyFilters(def, libraryIngredientCards(data), { ...defaultState(def), q: withAlias.aliases[0]!.toUpperCase() }).map((c) => c.slug);
    expect(found).toContain(withAlias.slug);
  });

  it("offers no household filters to a visitor", () => {
    expect(recipeFilters.facets.some((f) => f.key === "yours")).toBe(true);
    expect(anonymousRecipeFilters.facets.some((f) => f.key === "yours")).toBe(false);
    expect(anonymousRecipeFilters.facets.find((f) => f.key === "show")!.options.map((o) => o.value)).toEqual(["parts"]);
    expect(anonymousRecipeFilters.presets.map((p) => p.id)).not.toContain("tested");
  });
});

describe("library-mode rendering", () => {
  it("renders the full recipe list for a visitor, with search, sort and filters but no saved-view or feedback controls", () => {
    query = "";
    const out = html(createElement(RecipesClient, { recipes: libraryRecipeCards(data), savedDefault: null, mode: "anonymous" }));
    expect(out).toContain('href="/recipes/tofu-burrito-bowl"');
    expect(out).toContain("Search recipes");
    expect(out).toContain("Filters");
    expect(out).not.toContain("methi-water");
    expect(out).not.toMatch(PRIVATE);
    expect(out).not.toMatch(/Draft|Tested/);
  });

  it("applies the search from the link on first render", () => {
    query = "q=tofu%20burrito";
    const out = html(createElement(RecipesClient, { recipes: libraryRecipeCards(data), savedDefault: null, mode: "anonymous" }));
    expect(out).toContain('href="/recipes/tofu-burrito-bowl"');
    expect(out).not.toContain('href="/recipes/hummus"');
    query = "q=NoSuchLibraryRecipe";
    expect(html(createElement(RecipesClient, { recipes: libraryRecipeCards(data), savedDefault: null, mode: "anonymous" }))).toContain("No recipes match.");
    query = "";
  });

  it("renders ingredients with their weighed state", () => {
    const out = html(createElement(IngredientsClient, { items: libraryIngredientCards(data), savedDefault: null, mode: "anonymous" }));
    for (const i of data.ingredients.values()) expect(out).toContain(`href="/ingredients/${i.slug}"`);
    expect(out).not.toMatch(PRIVATE);
  });

  it("renders every meal and part with computed macros, method and linked parts, and nothing editable", () => {
    for (const recipe of data.recipes.values()) {
      if (recipe.kind === "routine") continue;
      const detail = libraryRecipeDetail(data, recipe.slug)!;
      const out = html(createElement(RecipeDetail, detail));
      const macros = perServing(recipe.slug, data.recipes, data.ingredients);
      expect(out).toContain(`${Math.round(macros.protein_g)}<span`);
      expect(out).toContain("Per serving");
      expect(out).toContain("Create an account to cook and save");
      expect(out).toMatch(/Method|Putting it together/);
      expect(out).not.toMatch(PRIVATE);
      expect(out).not.toContain("Draft: not cooked yet");
    }
  });

  it("renders every ingredient with its source and weighed state and no photos or profile-based values", () => {
    for (const ingredient of data.ingredients.values()) {
      const out = html(createElement(IngredientDetailView, libraryIngredientDetail(data, ingredient.slug)));
      expect(out).toContain(`Per 100 g (${ingredient.state})`);
      expect(out).toContain(ingredient.source_id);
      expect(out).toContain(displayName(ingredient));
      expect(out).not.toMatch(PRIVATE);
      expect(out).not.toMatch(/ man aged| woman aged/);
    }
  });

  it("renders the landing page with a call to make a plan", () => {
    const out = html(createElement(AnonymousHome, { highlights: libraryHighlights(data) }));
    expect(out).toContain('href="/plan/new"');
    expect(out).toContain("Make a plan");
    expect(out).not.toMatch(PRIVATE);
  });
});
