import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/SetupForm";
import type { SetupProps } from "@/components/SetupForm";
import { getRoutineCatalog } from "@/lib/routines/catalog";
import type { PersonRoutineView } from "@/lib/routines/types";
import { PageTitle } from "@/components/ui";
import { addDays, nextMonday } from "@/lib/planner/dates";
import { displayName } from "@/lib/schemas";
import { getData, getDb } from "@/lib/server/context";
import { photoIndex } from "@/lib/server/photo-index";
import { getCandidates, getPersonRoutines, getPrefs, lastSetup, listPeople, proteinTargetOf } from "@/lib/server/queries";
import { todayISO } from "@/lib/server/time";

export const metadata: Metadata = { title: "New plan" };
export const dynamic = "force-dynamic";

const PICKER_AISLES: Record<string, string> = {
  dairy: "Dairy",
  "soy-protein": "Soy and protein",
  legumes: "Legumes and dals",
  vegetables: "Vegetables",
  grains: "Grains",
  "nuts-seeds": "Nuts and seeds",
  fruit: "Fruit",
};

const ANCHORS: { slug: string; label: string }[] = [
  { slug: "paneer", label: "Paneer" },
  { slug: "tofu-extra-firm", label: "Tofu" },
  { slug: "soya-chunks-proxy-defatted-soy-flour", label: "Soya chunks" },
  { slug: "kidney-beans-dry", label: "Rajma" },
  { slug: "chickpeas-dry", label: "Chole" },
  { slug: "moong-whole-dry", label: "Moong" },
  { slug: "dahi-plain", label: "Dahi" },
  { slug: "tempeh", label: "Tempeh" },
  { slug: "edamame-prepared", label: "Edamame" },
];

export default async function NewPlanPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const member = await requirePageMember();
  const { step } = await searchParams;
  const people = await listPeople();
  if (people.length === 0) redirect("/profiles/new?next=/plan/new");
  const data = getData();
  const photos = await photoIndex(await getDb());
  const last = await lastSetup();
  const start = nextMonday(todayISO());
  const length = last ? (last.days === 14 ? "14" : last.days === 7 ? "7" : "7") : "7";

  const ingredients = [...data.ingredients.values()]
    .filter((i) => PICKER_AISLES[i.aisle])
    .map((i) => ({
      slug: i.slug,
      name: displayName(i),
      aliases: i.aliases,
      group: PICKER_AISLES[i.aisle]!,
      aisle: i.aisle,
      density: i.per100g.kcal > 0 ? (i.per100g.protein_g / i.per100g.kcal) * 100 : 0,
      image: photos.ingredients.get(i.slug) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const prefs: SetupProps["initial"]["prefs"] = {};
  for (const p of people) {
    const pr = await getPrefs(p.id);
    prefs[p.id] = { liked: pr.liked, avoided: pr.avoided };
  }
  const chosenRoutines: Record<number, PersonRoutineView[]> = {};
  for (const p of people) chosenRoutines[p.id] = await getPersonRoutines(p.id);
  const validIds = new Set(people.map((p) => p.id));
  const personIds = (last?.personIds.filter((id) => validIds.has(id)) ?? []).length ? last!.personIds.filter((id) => validIds.has(id)) : [people[0]!.id];

  const props: SetupProps = {
    people: people.map((p) => ({ id: p.id, name: p.name, proteinTarget: proteinTargetOf(p), kcalTarget: p.kcalTarget })),
    ingredients,
    anchors: ANCHORS.filter((a) => data.ingredients.has(a.slug)),
    recipes: (await getCandidates()).map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, activeMin: c.activeMin, slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots] })).sort((a, b) => a.name.localeCompare(b.name)),
    hasLastPlan: !!last,
    initialStep: step ?? null,
    routines: { catalog: getRoutineCatalog(data), chosen: chosenRoutines, editablePersonIds: people.filter((p) => member.role === "owner" || p.id === member.personId).map((p) => p.id) },
    initial: {
      personIds,
      length,
      start,
      end: addDays(start, 6),
      meals: last ? last.mealTypes : ["breakfast", "lunch", "dinner", "snack"],
      cuisineBalance: last?.cuisineBalance ?? 0.6,
      prepStyle: last?.prepStyle ?? "leftovers",
      health: last?.healthFocus ?? { nutrientDense: true, lowSugar: true, light: true },
      timeLimit: last?.maxActiveMin === 20 ? "always20" : last?.maxActiveMin && last.maxActiveMin > 100 ? "none" : "weeknights",
      prefs,
    },
  };

  return (
    <>
      <PageTitle title="New plan" sub="Five short steps. Your last choices are remembered, so a repeat week takes a minute." />
      <SetupForm {...props} />
    </>
  );
}
