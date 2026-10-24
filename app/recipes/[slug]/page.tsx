import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RecipeDetail } from "@/components/RecipeDetail";
import type { DetailItem, DetailProps } from "@/components/RecipeDetail";
import { displayName } from "@/lib/schemas";
import { isLight, isLowSugar, qualityPerServing } from "@/lib/nutrition/quality";
import { storageAdvice } from "@/lib/recipes/storage";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { effectiveActiveMin, makeAheadMin } from "@/lib/data/rules";
import { collectLinks, flattenParts } from "@/lib/recipes/linkview";
import { partsOf, usedIn } from "@/lib/recipes/parts";
import { anchorIngredients, perServing } from "@/lib/nutrition/macros";
import { microsPerServing } from "@/lib/nutrition/micros";
import { TARGETS, targetFor } from "@/lib/nutrition/dri";
import { autoTags } from "@/lib/nutrition/tags";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { getData } from "@/lib/server/context";
import { feedbackMap, getCandidates, getPartModes, getRecipeLinks, listPeople, listPlans } from "@/lib/server/queries";

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
  const m = perServing(slug, data.recipes, data.ingredients);
  const fb = (await feedbackMap()).get(slug);
  const sex = (await listPeople())[0]?.sex ?? "male";
  const dn = (k: string) => {
    const ing = data.ingredients.get(k);
    return ing ? displayName(ing) : k;
  };

  const items: DetailItem[] = r.items.map((it) => {
    if ("ingredient" in it) {
      const ing = data.ingredients.get(it.ingredient);
      return { kind: "ingredient", name: ing ? displayName(ing) : it.ingredient, state: ing?.state, image: ing?.image ?? null, grams: it.grams };
    }
    const sub = data.recipes.get(it.component)!;
    const yieldG = sub.items.reduce((a, b) => a + b.grams, 0);
    const parts = [...expandRecipe(it.component, (it.grams * sub.servings) / yieldG, data.recipes)].map(([k, g]) => ({
      name: dn(k),
      state: data.ingredients.get(k)?.state ?? "ready",
      grams: g,
    }));
    return { kind: "component", name: sub.name, grams: it.grams, parts };
  });

  const keys = TARGETS.filter((t) => t.key !== "fibre_g").map((t) => t.key);
  const micro = microsPerServing(slug, data.recipes, data.ingredients, data.micros, keys);
  const nutrients: DetailProps["nutrients"] = [
    { label: "Fibre", unit: "g", amount: m.fibre_g, target: targetFor("fibre_g", sex) ?? null, partial: false },
    ...micro
      .filter((n) => n.amount > 0 || n.missingFrom.length === 0)
      .map((n) => {
        const t = TARGETS.find((x) => x.key === n.key)!;
        return { label: t.label, unit: t.unit, amount: n.amount, target: targetFor(n.key, sex) ?? null, partial: n.missingFrom.length > 0 };
      }),
  ];

  // The plan in the URL (when it exists) is where Make / Buy / Have choices are read from and saved to.
  const requested = Number(plan);
  const planId = Number.isInteger(requested) && requested > 0 && (await listPlans(500)).some((pl) => pl.id === requested) ? requested : null;
  const partModes = planId ? await getPartModes(planId) : {};

  // Links saved on this page, plus the whole-page links saved on each part's own page (so a part's video shows in every meal).
  const parts = partsOf(r, data.recipes, data.ingredients, r.servings);
  const [ownLinks, partLinkEntries] = await Promise.all([
    getRecipeLinks(slug),
    Promise.all(flattenParts(parts).map(async (pt) => [pt.slug, await getRecipeLinks(pt.slug)] as const)),
  ]);
  const links = collectLinks(slug, ownLinks, Object.fromEntries(partLinkEntries.map(([s, ls]) => [s, ls.filter((l) => l.partSlug === null)])));

  const quality = qualityPerServing(slug, m, data.recipes, data.ingredients, data.micros);
  const candidate = (await getCandidates()).find((c) => c.slug === slug);
  const techniqueRefs = r.steps.map((s) => s.technique).filter((t): t is string => !!t);
  const props: DetailProps = {
    slug,
    name: r.name,
    image: r.image ?? null,
    thumbs: recipeThumbs(slug, data.recipes, data.ingredients),
    baseServings: r.servings,
    prepMin: r.prep_min,
    activeMin: r.active_min,
    totalMin: r.total_min,
    fridgeDays: r.fridge_days,
    equipment: r.equipment,
    cuisine: r.cuisine.replace(/-/g, " "),
    macros: { protein: m.protein_g, kcal: m.kcal, carbs: m.carbs_g, fat: m.fat_g, fibre: m.fibre_g },
    tags: autoTags(r, m, effectiveActiveMin(r, data.recipes)),
    anchors: anchorIngredients(slug, data.recipes, data.ingredients).map((a) => dn(a)),
    items,
    advancePrep: r.advance_prep.map((a) => ({ text: `${a.instruction}${a.grams ? ` (${a.grams} g)` : ""}, about ${a.lead_hours} hours ahead` })),
    steps: r.steps.map((s) => {
      const t = s.technique ? data.techniques.get(s.technique) : undefined;
      return { text: s.text, cue: s.cue ?? null, tip: s.tip ?? null, timerSec: s.timer_sec ?? null, technique: s.technique && t ? { slug: s.technique, title: t.title, body: t.body } : null };
    }),
    storage: storageAdvice(r),
    nutrients,
    quality: { freeSugarG: quality.freeSugarG, totalSugarG: quality.totalSugarG, sodiumMg: quality.sodiumMg, satFatG: quality.satFatG, kcal: quality.kcal, score: quality.score, partial: quality.partial, lowSugar: isLowSugar(quality), light: isLight(quality, r.meal_slots[0] ?? "dinner"), dense: candidate?.nutrientDense ?? false },
    targetFor: sex === "other" ? "male values" : `${sex} values`,
    feedback: { favourite: fb?.favourite ?? false, banned: fb?.banned ?? false, rating: fb?.rating ?? null, tested: fb?.tested ?? false },
    techniques: [...new Set(techniqueRefs)].map((t) => ({ slug: t, title: data.techniques.get(t)?.title ?? t })),
    kind: r.kind === "component" ? "component" : "recipe",
    parts,
    partModes,
    planId,
    makeAheadMin: makeAheadMin(r, data.recipes),
    mealAdvancePrep: r.advance_prep.map((a) => ({ leadHours: a.lead_hours, instruction: a.instruction })),
    usedIn: r.kind === "component" ? usedIn(slug, data.recipes) : [],
    links,
  };
  return <RecipeDetail {...props} />;
}
