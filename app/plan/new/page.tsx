import { requirePageMember } from "@/lib/auth/access";
import { optionalPageMember } from "@/lib/auth/public-access";
import { hasSessionCookie } from "@/lib/auth/session-cookie";
import { buildCandidates } from "@/lib/planner/candidates";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/SetupForm";
import type { SetupProps } from "@/components/SetupForm";
import { getRoutineCatalog } from "@/lib/routines/catalog";
import type { PersonRoutineView } from "@/lib/routines/types";
import { PageTitle } from "@/components/ui";
import { addDays, nextMonday } from "@/lib/planner/dates";
import { displayName } from "@/lib/schemas";
import { getData } from "@/lib/server/context";
import { getPhotoIndex } from "@/lib/server/queries";
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

/** Visitors plan on their own device: library data only, no household, no feedback, no photos. */
async function AnonymousNewPlan({ stepParam }: { stepParam: Promise<{ step?: string }> }) {
  const step = (await stepParam).step ?? null;
  const data = getData();
  const start = nextMonday(todayISO());
  const props: SetupProps = {
    people: [],
    ingredients: [...data.ingredients.values()].filter((i) => PICKER_AISLES[i.aisle]).map((i) => ({
      slug: i.slug, name: displayName(i), aliases: i.aliases, group: PICKER_AISLES[i.aisle]!, aisle: i.aisle,
      density: i.per100g.kcal > 0 ? (i.per100g.protein_g / i.per100g.kcal) * 100 : 0, image: null,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    anchors: ANCHORS.filter((a) => data.ingredients.has(a.slug)),
    recipes: buildCandidates(data).map((c) => ({ slug: c.slug, name: c.name, proteinG: c.perServing.protein_g, activeMin: c.activeMin, slots: c.family === "shakes" ? ["shake"] : [...c.mealSlots] })).sort((a, b) => a.name.localeCompare(b.name)),
    hasLastPlan: false,
    initialStep: step,
    routines: { catalog: [], chosen: {}, editablePersonIds: [] },
    initial: {
      personIds: [1], length: "7", start, end: addDays(start, 6), meals: ["breakfast", "lunch", "dinner", "snack"], cuisineBalance: 0.6,
      prepStyle: "leftovers", health: { nutrientDense: true, lowSugar: true, light: true }, timeLimit: "weeknights", prefs: {},
    },
  };
  return (
    <>
      <PageTitle title="New plan" sub="Five short steps. Your plan stays on this device until you save it to an account." />
      <SetupForm {...props} anonymous />
    </>
  );
}

export default async function NewPlanPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  if (!await optionalPageMember() && !await hasSessionCookie()) {
    return <AnonymousNewPlan stepParam={searchParams} />;
  }
  const member = await requirePageMember();
  const { step } = await searchParams;
  const people = await listPeople();
  if (people.length === 0) redirect("/profiles/new?next=/plan/new");
  const data = getData();
  const photos = await getPhotoIndex();
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
