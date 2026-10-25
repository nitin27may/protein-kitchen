import { requirePageMember } from "@/lib/auth/access";
import { optionalPageMember } from "@/lib/auth/public-access";
import { IngredientDetailView } from "@/components/IngredientDetailView";
import { libraryIngredientDetail } from "@/lib/library/anonymous";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { displayName } from "@/lib/schemas";
import { getData } from "@/lib/server/context";
import { getIngredientPhotos, getPhotoIndex, listPeople } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const ing = getData().ingredients.get(slug);
  return { title: ing ? displayName(ing) : "Ingredient" };
}

export default async function IngredientPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = getData();
  const ing = data.ingredients.get(slug);
  if (!ing) notFound();
  if (!await optionalPageMember()) return <IngredientDetailView {...libraryIngredientDetail(data, slug)} />;
  const member = await requirePageMember();
  const sex = (await listPeople()).find((person) => person.id === member.personId)!.sex;
  const photoIdx = await getPhotoIndex();
  const cover = (await getIngredientPhotos(slug)).find((x) => x.isCover);
  return <IngredientDetailView data={data} slug={slug} sex={sex} cover={cover} recipePhotos={photoIdx.recipes} ingredientPhotos={photoIdx.ingredients} />;
}
