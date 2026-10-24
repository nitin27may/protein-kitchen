import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { IngredientsClient } from "@/components/IngredientsClient";
import type { IngredientCard } from "@/components/IngredientsClient";
import { Suspense } from "react";
import { PageTitle } from "@/components/ui";
import { displayName } from "@/lib/schemas";
import { getData, getDb } from "@/lib/server/context";
import { getDefaultViewQuery } from "@/lib/server/queries";
import { photoIndex } from "@/lib/server/photo-index";

export const metadata: Metadata = { title: "Ingredients" };
export const dynamic = "force-dynamic";

export default async function IngredientsPage() {
  await requirePageMember();
  const data = getData();
  const photos = await photoIndex(await getDb());
  const cards: IngredientCard[] = [...data.ingredients.values()].map((i) => {
    return {
      slug: i.slug,
      name: displayName(i),
      aliases: i.aliases,
      aisle: i.aisle,
      state: i.state,
      image: photos.ingredients.get(i.slug) ?? null,
      kcal: i.per100g.kcal,
      proteinG: i.per100g.protein_g,
      carbsG: i.per100g.carbs_g,
      fatG: i.per100g.fat_g,
      fibreG: i.per100g.fibre_g,
      isDairy: i.is_dairy,
      onionGarlic: i.contains_onion_garlic,
    };
  });
  const savedDefault = await getDefaultViewQuery("ingredients");
  return (
    <>
      <PageTitle title="Ingredients" sub="Per 100 g in the state shown. Open one for full nutrition and how to get the most from it." />
      <Suspense fallback={null}>
        <IngredientsClient items={cards} savedDefault={savedDefault} />
      </Suspense>
    </>
  );
}
