"use client";

import Link from "next/link";
import { FilterToolbar } from "@/components/FilterToolbar";
import { RecipeThumb } from "@/components/RecipeThumb";
import { Pill } from "@/components/ui";
import { recipeFilters } from "@/lib/filters/recipes";
import type { RecipeCardData } from "@/lib/filters/recipes";

export type { RecipeCardData } from "@/lib/filters/recipes";

export function RecipesClient({ recipes, savedDefault }: { recipes: RecipeCardData[]; savedDefault: string | null }) {
  return (
    <FilterToolbar list="recipes" def={recipeFilters} items={recipes} savedDefault={savedDefault}
      noun={{ one: "recipe", many: "recipes" }} searchLabel="Search recipes" searchPlaceholder="Search recipes, cuisines or meal types">
      {(shown) => (
        <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {shown.map((r) => (
            <li key={r.slug}>
              <Link href={`/recipes/${r.slug}`} className="group flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface transition-colors hover:border-primary">
                <RecipeThumb image={r.image} thumbs={r.thumbs} label={r.family} className="aspect-[4/3] w-full" />
                <div className="flex flex-1 flex-col p-3">
                  <h2 className="text-base font-semibold leading-snug group-hover:underline">{r.name}</h2>
                  <p className="mt-1 font-display text-2xl font-bold tabular-nums leading-none">{Math.round(r.proteinG)}<span className="ml-1 text-sm font-medium text-muted">g protein</span></p>
                  <p className="mt-1 text-sm text-muted tabular-nums">{Math.round(r.kcal)} kcal, {r.activeMin} min active</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.dense ? <Pill tone="ok">Nutrient-dense</Pill> : null}
                    {r.light ? <Pill tone="info">Light</Pill> : null}
                    {r.lowSugar ? <Pill tone="info">Low sugar</Pill> : null}
                    {r.tags.includes("high-fibre") ? <Pill tone="info">High fibre</Pill> : null}
                    {r.favourite ? <Pill tone="warn">Favourite</Pill> : null}
                    {r.kind === "component" ? <Pill>Part of a meal</Pill> : r.tested ? <Pill tone="ok">Tested{r.rating ? ` ${r.rating}/5` : ""}</Pill> : <Pill>Draft</Pill>}
                    {r.banned ? <Pill tone="bad">Hidden</Pill> : null}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </FilterToolbar>
  );
}
