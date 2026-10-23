import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CookMode } from "@/components/CookMode";
import { displayName } from "@/lib/schemas";
import type { Ingredient } from "@/lib/schemas";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { getData } from "@/lib/server/context";

export const metadata: Metadata = { title: "Cook mode" };
export const dynamic = "force-dynamic";

const ingName = (i: Ingredient | undefined, fallback: string) => (i ? displayName(i) : fallback);

export default async function CookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = getData();
  const r = data.recipes.get(slug);
  if (!r) notFound();
  const ingredients = [...expandRecipe(slug, r.servings, data.recipes)]
    .map(([k, g]) => ({ name: ingName(data.ingredients.get(k), k), grams: g }))
    .sort((a, b) => b.grams - a.grams);
  const steps = r.steps.map((s) => {
    const t = s.technique ? data.techniques.get(s.technique) : undefined;
    return { text: s.text, cue: s.cue ?? null, tip: s.tip ?? null, timerSec: s.timer_sec ?? null, technique: t ? { title: t.title, body: t.body } : null };
  });
  return <CookMode slug={slug} name={r.name} servings={r.servings} steps={steps} ingredients={ingredients} />;
}
