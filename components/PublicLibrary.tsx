import Link from "next/link";
import { Markdown } from "./Markdown";
import { Card, LinkButton, PageTitle } from "./ui";
import type { DataSet } from "@/lib/data/load";
import { effectiveActiveMin } from "@/lib/data/rules";
import { perServing } from "@/lib/nutrition/macros";
import { storageAdvice } from "@/lib/recipes/storage";
import { displayName } from "@/lib/schemas";

const fmt = (n: number) => Math.round(n * 10) / 10;

export function PublicCatalog({ data, kind, query = "" }: { data: DataSet; kind: "recipes" | "ingredients"; query?: string }) {
  const search = query.trim().toLocaleLowerCase("en-CA");
  const items = kind === "recipes"
    ? [...data.recipes.values()].filter((r) => r.kind !== "routine").map((r) => {
      const m = perServing(r.slug, data.recipes, data.ingredients);
      return { slug: r.slug, name: r.name, search: `${r.name} ${r.cuisine} ${r.family}`, text: `${fmt(m.protein_g)} g protein, ${Math.round(m.kcal)} kcal per serving`, detail: `${effectiveActiveMin(r, data.recipes)} min active${r.kind === "component" ? " · Part of a meal" : ""}` };
    })
    : [...data.ingredients.values()].map((i) => ({
      slug: i.slug, name: displayName(i), search: `${displayName(i)} ${i.aliases.join(" ")} ${i.aisle}`,
      text: `${fmt(i.per100g.protein_g)} g protein, ${Math.round(i.per100g.kcal)} kcal per 100 g`, detail: `${i.state} · ${i.aisle.replace(/-/g, " ")}`,
    }));
  const shown = items.filter((i) => i.search.toLocaleLowerCase("en-CA").includes(search));
  const title = kind === "recipes" ? "Recipes" : "Ingredients";
  return (
    <div className="pb-10">
      <PageTitle title={title} sub="Explore the vegetarian library. Nutrition is computed from sourced ingredient data." />
      <div className="space-y-4 p-4">
        <form action={`/${kind}`} className="flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm font-semibold">Search {kind}</span>
            <input name="q" defaultValue={query} type="search" className="min-h-11 rounded-control border border-line bg-surface px-3" />
          </label>
          <button className="min-h-11 self-end rounded-control bg-primary px-4 font-semibold text-primaryfg">Search</button>
        </form>
        <p role="status" className="text-sm text-muted">{shown.length} {kind}</p>
        {shown.length === 0 ? <p>No matches. Try another name.</p> : null}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((i) => <li key={i.slug}>
            <Link href={`/${kind}/${i.slug}`} className="block h-full rounded-card border border-line bg-surface p-4 hover:border-primary">
              <h2 className="font-semibold">{i.name}</h2>
              <p className="mt-2">{i.text}</p><p className="mt-1 text-sm text-muted">{i.detail}</p>
            </Link>
          </li>)}
        </ul>
      </div>
    </div>
  );
}

export function PublicRecipe({ data, slug }: { data: DataSet; slug: string }) {
  const r = data.recipes.get(slug)!;
  const m = perServing(slug, data.recipes, data.ingredients);
  return (
    <div className="space-y-4 p-4 pb-10">
      <Link href="/recipes" className="inline-flex min-h-11 items-center text-primary">All recipes</Link>
      <h1 className="text-2xl font-bold">{r.name}</h1>
      <p>{r.kind === "component" ? "Part of a meal. " : ""}{r.servings} servings · {effectiveActiveMin(r, data.recipes)} min active · {r.total_min} min total</p>
      <Card><h2 className="font-semibold">Nutrition per serving</h2><p className="mt-2">{fmt(m.protein_g)} g protein · {Math.round(m.kcal)} kcal · {fmt(m.carbs_g)} g carbs · {fmt(m.fat_g)} g fat · {fmt(m.fibre_g)} g fibre</p></Card>
      <Card>
        <h2 className="font-semibold">Ingredients for {r.servings} servings</h2>
        <ul className="mt-2 space-y-2">{r.items.map((item, i) => <li key={i}>
          {fmt(item.grams)} g{" "}
          {"ingredient" in item
            ? <Link href={`/ingredients/${item.ingredient}`} className="text-primary underline">{displayName(data.ingredients.get(item.ingredient)!)}</Link>
            : <Link href={`/recipes/${item.component}`} className="text-primary underline">{data.recipes.get(item.component)!.name}</Link>}
          {item.optional ? " (optional)" : ""}
        </li>)}</ul>
      </Card>
      {r.advance_prep.length ? <Card><h2 className="font-semibold">Prepare ahead</h2><ul className="mt-2 space-y-2">{r.advance_prep.map((p, i) => <li key={i}>{p.instruction} · {p.lead_hours} hours ahead</li>)}</ul></Card> : null}
      <Card>
        <h2 className="font-semibold">Method</h2>
        <ol className="mt-3 list-decimal space-y-4 pl-5">{r.steps.map((step, i) => <li key={i}>
          <p>{step.text}</p>
          {step.cue ? <p className="mt-1 text-sm"><strong>Done when:</strong> {step.cue}</p> : null}
          {step.tip ? <p className="mt-1 text-sm text-muted">Tip: {step.tip}</p> : null}
          {step.technique && data.techniques.has(step.technique) ? <details className="mt-2">
            <summary className="min-h-11 cursor-pointer text-primary">{data.techniques.get(step.technique)!.title}</summary>
            <Markdown>{data.techniques.get(step.technique)!.body}</Markdown>
          </details> : null}
        </li>)}</ol>
      </Card>
      <Card><h2 className="font-semibold">Storage</h2><p className="mt-2">{storageAdvice(r)}</p></Card>
      <LinkButton href="/sign-in" variant="secondary">Sign in to plan meals and save your choices</LinkButton>
    </div>
  );
}

export function PublicIngredient({ data, slug }: { data: DataSet; slug: string }) {
  const i = data.ingredients.get(slug)!;
  const p = i.per100g;
  return (
    <div className="space-y-4 p-4 pb-10">
      <Link href="/ingredients" className="inline-flex min-h-11 items-center text-primary">All ingredients</Link>
      <h1 className="text-2xl font-bold">{displayName(i)}</h1>
      <p>{i.state} · {i.aisle.replace(/-/g, " ")}</p>
      {i.aliases.length ? <p>Also called: {i.aliases.join(", ")}</p> : null}
      <Card><h2 className="font-semibold">Nutrition per 100 g ({i.state})</h2><p className="mt-2">{fmt(p.protein_g)} g protein · {Math.round(p.kcal)} kcal · {fmt(p.carbs_g)} g carbs · {fmt(p.fat_g)} g fat · {fmt(p.fibre_g)} g fibre</p></Card>
      <Card><h2 className="font-semibold">Nutrition source</h2><p className="mt-2">{i.source} · {i.source_id}</p></Card>
      <p>{i.is_dairy ? "Contains dairy." : "Not a dairy ingredient."} {i.contains_onion_garlic ? "Contains onion or garlic." : "No onion or garlic."}</p>
      {i.cooked_yield ? <p>Cooked yield: approximately {i.cooked_yield} g for every 1 g dry.</p> : null}
    </div>
  );
}
