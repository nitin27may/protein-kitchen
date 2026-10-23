import type { Metadata } from "next";
import { RecipesClient } from "@/components/RecipesClient";
import type { RecipeCardData } from "@/components/RecipesClient";
import { Suspense } from "react";
import { PageTitle } from "@/components/ui";
import { perServing } from "@/lib/nutrition/macros";
import { autoTags } from "@/lib/nutrition/tags";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { getData } from "@/lib/server/context";
import { feedbackMap, getCandidates, getDefaultViewQuery } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Recipes" };
export const dynamic = "force-dynamic";

export default async function RecipesPage() {
  const data = getData();
  const fb = await feedbackMap();
  const cards: RecipeCardData[] = (await getCandidates()).map((c) => {
    const r = data.recipes.get(c.slug)!;
    const f = fb.get(c.slug);
    return {
      slug: c.slug,
      name: c.name,
      family: c.family,
      cuisine: r.cuisine,
      slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots],
      proteinG: c.perServing.protein_g,
      kcal: c.perServing.kcal,
      activeMin: c.activeMin,
      isIndian: c.isIndian,
      tags: autoTags(r, c.perServing),
      lowSugar: c.lowSugar,
      light: c.light,
      dense: c.nutrientDense,
      image: r.image ?? null,
      kind: "recipe" as const,
      thumbs: recipeThumbs(c.slug, data.recipes, data.ingredients),
      favourite: f?.favourite ?? false,
      tested: f?.tested ?? false,
      rating: f?.rating ?? null,
      banned: f?.banned ?? false,
    };
  });
  // Parts of meals (hummus, dressings) are listed too; the filter hides them until "Parts of meals" is on.
  const parts: RecipeCardData[] = [...data.recipes.values()]
    .filter((r) => r.kind === "component")
    .map((r) => {
      const m = perServing(r.slug, data.recipes, data.ingredients);
      const f = fb.get(r.slug);
      return {
        slug: r.slug,
        name: r.name,
        kind: "component" as const,
        family: r.family,
        cuisine: r.cuisine,
        slots: [],
        proteinG: m.protein_g,
        kcal: m.kcal,
        activeMin: r.active_min,
        isIndian: r.is_indian,
        tags: [],
        lowSugar: false,
        light: false,
        dense: false,
        image: r.image ?? null,
        thumbs: recipeThumbs(r.slug, data.recipes, data.ingredients),
        favourite: f?.favourite ?? false,
        tested: f?.tested ?? false,
        rating: f?.rating ?? null,
        banned: f?.banned ?? false,
      };
    });
  const savedDefault = await getDefaultViewQuery("recipes");
  return (
    <>
      <PageTitle title="Recipes" sub="Protein and calories are computed from the ingredients, never typed in." />
      <Suspense fallback={null}>
        <RecipesClient recipes={[...cards, ...parts]} savedDefault={savedDefault} />
      </Suspense>
    </>
  );
}
