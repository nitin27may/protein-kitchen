import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CookMode } from "@/components/CookMode";
import type { CookTechnique } from "@/components/CookMode";
import { displayName } from "@/lib/schemas";
import type { Ingredient } from "@/lib/schemas";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { resolverFor } from "@/lib/parts/resolve";
import { prepareCook } from "@/lib/recipes/cookplan";
import { collectLinks } from "@/lib/recipes/linkview";
import { getData } from "@/lib/server/context";
import { getPartModes, getRecipeLinks, listPlans } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Cook mode" };
export const dynamic = "force-dynamic";

const ingName = (i: Ingredient | undefined, fallback: string) => (i ? displayName(i) : fallback);

export default async function CookPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ plan?: string }> }) {
  await requirePageMember();
  const { slug } = await params;
  const { plan } = await searchParams;
  const data = getData();
  const r = data.recipes.get(slug);
  if (!r) notFound();

  // The plan in the URL (when it exists) says which parts are made, bought or already in the fridge.
  const requested = Number(plan);
  const planId = Number.isInteger(requested) && requested > 0 && (await listPlans(500)).some((pl) => pl.id === requested) ? requested : null;
  const partModes = planId ? await getPartModes(planId) : {};

  const input = prepareCook(r, data.recipes, data.ingredients, partModes, r.servings);

  // Links saved on this page, plus the whole-page links saved on each part's own page.
  const partSlugs = [...new Set(input.parts.map((p) => p.slug))];
  const [ownLinks, partLinkEntries] = await Promise.all([getRecipeLinks(slug), Promise.all(partSlugs.map(async (s) => [s, await getRecipeLinks(s)] as const))]);
  const links = collectLinks(slug, ownLinks, Object.fromEntries(partLinkEntries.map(([s, ls]) => [s, ls.filter((l) => l.partSlug === null)])));

  const techniques: Record<string, CookTechnique> = {};
  for (const track of input.tracks) {
    for (const step of track.steps) {
      const t = step.technique ? data.techniques.get(step.technique) : undefined;
      if (step.technique && t) techniques[step.technique] = { title: t.title, body: t.body };
    }
  }

  const ingredients = [...expandRecipe(slug, r.servings, data.recipes, [], resolverFor(partModes))]
    .map(([k, g]) => ({ name: ingName(data.ingredients.get(k), k), grams: g }))
    .sort((a, b) => b.grams - a.grams);

  return <CookMode slug={slug} name={r.name} servings={r.servings} planId={planId} input={input} techniques={techniques} ingredients={ingredients} links={links} />;
}
