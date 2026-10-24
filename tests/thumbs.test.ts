import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadData } from "../lib/data/load";
import { MIN_COLLAGE_PHOTOS, recipeThumbs } from "../lib/recipes/thumbs";
import type { Ingredient, Recipe } from "../lib/schemas";

const data = loadData(path.join(__dirname, ".."));

const ing = (slug: string, aisle: string): Ingredient => ({ slug, aisle } as unknown as Ingredient);
const recipe = (slug: string, items: { ingredient: string; grams: number }[]): Recipe => ({ slug, servings: 1, items, kind: "recipe" } as unknown as Recipe);

describe("recipeThumbs", () => {
  const ingredients = new Map([
    ["a", ing("a", "vegetables")],
    ["b", ing("b", "grains")],
    ["c", ing("c", "legumes")],
    ["salt", ing("salt", "spices")],
    ["bare", ing("bare", "dairy")],
  ]);
  const photos = new Map([["a", "/photos/a/thumb"], ["b", "/photos/b/thumb"], ["c", "/photos/c/thumb"], ["salt", "/photos/salt/thumb"]]);
  const thumbsFor = (items: { ingredient: string; grams: number }[]) => recipeThumbs("r", new Map([["r", recipe("r", items)]]), ingredients, photos);

  it("gives no collage with one or two photos", () => {
    expect(thumbsFor([{ ingredient: "a", grams: 100 }])).toEqual([]);
    expect(thumbsFor([{ ingredient: "a", grams: 100 }, { ingredient: "b", grams: 50 }, { ingredient: "bare", grams: 80 }])).toEqual([]);
  });

  it("gives a collage of the heaviest ingredients with three or more, skipping seasonings", () => {
    const t = thumbsFor([{ ingredient: "a", grams: 100 }, { ingredient: "b", grams: 200 }, { ingredient: "c", grams: 50 }, { ingredient: "salt", grams: 300 }]);
    expect(t).toEqual(["/photos/b/thumb", "/photos/a/thumb", "/photos/c/thumb"]);
    expect(t.length).toBeGreaterThanOrEqual(MIN_COLLAGE_PHOTOS);
  });

  it("never returns a lone ingredient photo for the falafel bowl, even when one of its ingredients has a photo", () => {
    const romaine = new Map([["lettuce-romaine", "/photos/romaine/thumb"]]);
    expect(recipeThumbs("falafel-bowl", data.recipes, data.ingredients, romaine)).toEqual([]);
  });

  it("returns only empty or 3-4 photos for every recipe", () => {
    const everything = new Map([...data.ingredients.keys()].map((k) => [k, `/photos/${k}/thumb`] as const));
    for (const r of data.recipes.values()) {
      const n = recipeThumbs(r.slug, data.recipes, data.ingredients, everything).length;
      expect(n === 0 || (n >= 3 && n <= 4), r.slug).toBe(true);
    }
  });
});
