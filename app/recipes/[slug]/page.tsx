import { requirePageMember } from "@/lib/auth/access";
import { optionalPageMember } from "@/lib/auth/public-access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RecipeDetail } from "@/components/RecipeDetail";
import { libraryRecipeDetail } from "@/lib/library/anonymous";
import { recipeDetailFromLibrary } from "@/lib/library/recipe-detail";
import { collectLinks, flattenParts } from "@/lib/recipes/linkview";
import { getData } from "@/lib/server/context";
import { getPhotoIndex, getRecipePhotos } from "@/lib/server/queries";
import { feedbackMap, getCandidates, getPartModes, getRecipeLinks, listPeople, listPlans, recipeIds } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: getData().recipes.get(slug)?.name ?? "Recipe" };
}

export default async function RecipePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ plan?: string }> }) {
  const { slug } = await params;
  const { plan } = await searchParams;
  const data = getData();
  const r = data.recipes.get(slug);
  if (!r) notFound();
  if (!await optionalPageMember()) {
    const detail = libraryRecipeDetail(data, slug);
    if (!detail) notFound();
    return <RecipeDetail {...detail} />;
  }
  const member = await requirePageMember();
  const fb = (await feedbackMap(member.personId)).get(slug);
  const history = (await feedbackMap()).get(slug);
  const sex = (await listPeople()).find((person) => person.id === member.personId)!.sex;
  const photoIdx = await getPhotoIndex();

  // The plan in the URL (when it exists) is where Make / Buy / Have choices are read from and saved to.
  const requested = Number(plan);
  const planId = Number.isInteger(requested) && requested > 0 && (await listPlans(500)).some((pl) => pl.id === requested) ? requested : null;
  const partModes = planId ? await getPartModes(planId) : {};

  const base = recipeDetailFromLibrary(data, slug, {
    sex,
    targetLabel: sex === "other" ? "male values" : `${sex} values`,
    ingredientPhotos: photoIdx.ingredients,
    dense: (await getCandidates()).find((c) => c.slug === slug)?.nutrientDense ?? false,
  });

  // Links saved on this page, plus the whole-page links saved on each part's own page (so a part's video shows in every meal).
  const [ownLinks, partLinkEntries] = await Promise.all([
    getRecipeLinks(slug),
    Promise.all(flattenParts(base.parts).map(async (pt) => [pt.slug, await getRecipeLinks(pt.slug)] as const)),
  ]);
  const links = collectLinks(slug, ownLinks, Object.fromEntries(partLinkEntries.map(([s, ls]) => [s, ls.filter((l) => l.partSlug === null)])));

  const recipeId = (await recipeIds()).bySlug.get(slug);
  const photos = recipeId === undefined ? [] : await getRecipePhotos(recipeId);
  const cover = photos.find((x) => x.isCover);

  return (
    <RecipeDetail
      {...base}
      image={cover?.url ?? null}
      photos={photos}
      feedback={{ favourite: fb?.favourite ?? false, banned: fb?.banned ?? false, rating: fb?.rating ?? null, tested: fb?.tested ?? false }}
      earlierFeedback={history && (history.rating !== null || history.favourite) ? { rating: history.rating, favourite: history.favourite } : null}
      partModes={partModes}
      planId={planId}
      links={links}
    />
  );
}
