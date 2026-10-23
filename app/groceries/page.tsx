import type { Metadata } from "next";
import { GroceryClient } from "@/components/GroceryClient";
import type { GroceryLineView } from "@/components/GroceryClient";
import { EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { buildGroceryList } from "@/lib/grocery/aggregate";
import { addDays, formatDay } from "@/lib/planner/dates";
import { getData } from "@/lib/server/context";
import { getPartModes, getPlanView, groceryChecks, latestPlanId } from "@/lib/server/queries";

export const metadata: Metadata = { title: "Groceries" };
export const dynamic = "force-dynamic";

export default async function GroceriesPage({ searchParams }: { searchParams: Promise<{ plan?: string; w?: string }> }) {
  const sp = await searchParams;
  const planId = sp.plan && Number.isInteger(Number(sp.plan)) ? Number(sp.plan) : await latestPlanId();
  const view = planId ? await getPlanView(planId) : undefined;
  if (!view) {
    return (
      <>
        <PageTitle title="Groceries" />
        <EmptyState title="No list yet" body="Make a plan and the shopping list is built from it, grouped by aisle." action={<LinkButton href="/plan/new">Make a plan</LinkButton>} />
      </>
    );
  }

  const data = getData();
  const weeksCount = Math.ceil(view.dates.length / 7);
  const w = sp.w === undefined ? -1 : Math.min(weeksCount - 1, Math.max(0, Number(sp.w) || 0));
  const from = w < 0 ? view.startDate : addDays(view.startDate, w * 7);
  const to = w < 0 ? view.endDate : [addDays(view.startDate, w * 7 + 6), view.endDate].sort()[0]!;
  const meals = view.slots
    .filter((s) => s.date >= from && s.date <= to)
    .map((s) => ({ recipeSlug: s.recipeSlug, servings: Object.values(s.servings).reduce((a, b) => a + b, 0) }));

  const list = buildGroceryList(meals, data.recipes, data.ingredients, await getPartModes(view.id));
  const state = await groceryChecks(view.id);
  const lines: GroceryLineView[] = list.lines.map((l) => ({
    slug: l.ingredient,
    name: l.name,
    state: l.state,
    aisle: l.aisle,
    image: data.ingredients.get(l.ingredient)?.image ?? null,
    needG: l.grams,
    buyG: l.buyGrams,
    packs: l.packs,
    pantry: l.isPantryStaple,
    recipes: l.recipes.map((r) => data.recipes.get(r)?.name ?? r),
    checked: state.checked.has(l.ingredient),
  }));

  const weeks =
    weeksCount > 1
      ? [{ label: "Whole plan", href: "/groceries", active: w < 0 }, ...Array.from({ length: weeksCount }, (_, i) => ({ label: `Week ${i + 1}`, href: `/groceries?w=${i}`, active: w === i }))]
      : [];

  return (
    <>
      <PageTitle title="Groceries" sub="Amounts are rounded up so you do not run short." />
      <GroceryClient
        key={`${view.id}-${w}`}
        planId={view.id}
        rangeLabel={`${formatDay(from).long} to ${formatDay(to).long}`}
        weeks={weeks}
        lines={lines}
        singleUse={list.singleUseItems}
        manual={state.manual}
      />
    </>
  );
}
