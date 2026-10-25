import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PublicCatalog, PublicIngredient, PublicRecipe } from "../components/PublicLibrary";
import { loadData, type DataSet } from "../lib/data/load";
import { displayName } from "../lib/schemas";
import { perServing } from "../lib/nutrition/macros";

vi.mock("../lib/server/context", () => ({
  getDb: () => { throw new Error("Public rendering must not open the household database."); },
}));

let data: DataSet;
beforeAll(() => { data = loadData(process.cwd()); });
const render = <P extends object>(component: FunctionComponent<P>, props: NoInfer<P>) => renderToStaticMarkup(createElement(component, props));

describe("library-only public rendering", () => {
  it("lists meals and components but not personal routines or household controls", () => {
    const html = render(PublicCatalog, { data, kind: "recipes" });
    for (const recipe of data.recipes.values()) {
      const link = `href="/recipes/${recipe.slug}"`;
      if (recipe.kind === "routine") expect(html).not.toContain(link);
      else expect(html).toContain(link);
    }
    expect(html).not.toMatch(/\/photos\/|Favourite|Save view|Hidden|\/profiles/);
  });

  it("searches recipes case-insensitively by name and cuisine, with an explicit empty state", () => {
    const byName = render(PublicCatalog, { data, kind: "recipes", query: "  TOFU BURRITO  " });
    expect(byName).toContain('href="/recipes/tofu-burrito-bowl"');
    expect(byName).not.toContain('href="/recipes/hummus"');
    expect(render(PublicCatalog, { data, kind: "recipes", query: "mexican" })).toContain('href="/recipes/tofu-burrito-bowl"');
    expect(render(PublicCatalog, { data, kind: "recipes", query: "NoSuchLibraryRecipe" })).toContain("No matches. Try another name.");
  });

  it("lists ingredients with their weighed state and searches aliases without saved private defaults", () => {
    const html = render(PublicCatalog, { data, kind: "ingredients" });
    for (const ingredient of data.ingredients.values()) expect(html).toContain(`href="/ingredients/${ingredient.slug}"`);
    const withAlias = [...data.ingredients.values()].find((i) => i.aliases.length)!;
    expect(render(PublicCatalog, { data, kind: "ingredients", query: withAlias.aliases[0]!.toUpperCase() }))
      .toContain(`href="/ingredients/${withAlias.slug}"`);
    expect(html).not.toMatch(/\/photos\/|Save view|\/settings/);
  });

  it("renders every meal and component with source-computed macros, method and linked parts, without personal targets or editable state", () => {
    for (const recipe of data.recipes.values()) {
      if (recipe.kind === "routine") continue;
      const html = render(PublicRecipe, { data, slug: recipe.slug });
      const macros = perServing(recipe.slug, data.recipes, data.ingredients);
      expect(html).toContain(`${Math.round(macros.protein_g * 10) / 10} g protein`);
      expect(html).toContain(`${Math.round(macros.kcal)} kcal`);
      expect(html).toContain("Nutrition per serving");
      expect(html).toContain("Method");
      for (const item of recipe.items) {
        expect(html).toContain("ingredient" in item ? `href="/ingredients/${item.ingredient}"` : `href="/recipes/${item.component}"`);
      }
      expect(html).not.toMatch(/\/photos\/|Favourite|Upload photo|Earlier household|male values|female values|Make \/ Buy/);
    }
  });

  it("renders every ingredient's source and weighed state without household photos or profile-based daily values", () => {
    for (const ingredient of data.ingredients.values()) {
      const html = render(PublicIngredient, { data, slug: ingredient.slug });
      expect(html).toContain(`Nutrition per 100 g (${ingredient.state})`);
      expect(html).toContain(ingredient.source_id);
      expect(html).toContain(ingredient.source);
      expect(html).not.toMatch(/\/photos\/|Daily value|male values|female values/);
      expect(html).toContain(renderToStaticMarkup(createElement("h1", { className: "text-2xl font-bold" }, displayName(ingredient))));
    }
  });
});
