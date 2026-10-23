"use client";

import Link from "next/link";
import { useMemo } from "react";
import { FilterToolbar } from "@/components/FilterToolbar";
import { ingredientFilters } from "@/lib/filters/ingredients";
import type { IngredientCard } from "@/lib/filters/ingredients";
import { aisleLabel } from "@/lib/format";
import { energySplit } from "@/lib/nutrition/energy";

export type { IngredientCard } from "@/lib/filters/ingredients";

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-CA", { maximumFractionDigits: 1 });

export function IngredientsClient({ items, savedDefault }: { items: IngredientCard[]; savedDefault: string | null }) {
  const def = useMemo(() => ingredientFilters([...new Set(items.map((i) => i.aisle))]), [items]);
  return (
    <FilterToolbar list="ingredients" def={def} items={items} savedDefault={savedDefault}
      noun={{ one: "ingredient", many: "ingredients" }} searchLabel="Search ingredients" searchPlaceholder="Search by name, or Hindi or Punjabi name">
      {(shown) => (
        <>
          <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {shown.map((i) => {
          const e = energySplit(i.proteinG, i.carbsG, i.fatG);
          return (
            <li key={i.slug}>
              <Link href={`/ingredients/${i.slug}`} className="group flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface hover:border-primary">
                <div className="aspect-[4/3] w-full overflow-hidden bg-primarysoft">
                  {i.image ? (
                    <img src={`/ingredient-images/${i.image}`} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
                  ) : (
                    <div className="flex size-full items-center justify-center text-sm font-semibold text-primary">{aisleLabel(i.aisle)}</div>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-3">
                  <h2 className="text-base font-semibold leading-snug">{i.name}</h2>
                  <p className="text-xs text-muted">{aisleLabel(i.aisle)} · {i.state}</p>
                  <p className="mt-2 text-sm tabular-nums"><strong>{fmt(i.proteinG)} g</strong> protein <span className="text-muted">· {Math.round(i.kcal)} kcal</span></p>
                  <div role="img" aria-label={`Energy from protein ${Math.round(e.p)} percent, carbs ${Math.round(e.c)} percent, fat ${Math.round(e.f)} percent`}
                    className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-surface2">
                    <span className="bg-primary" style={{ width: `${e.p}%` }} />
                    <span className="bg-warn" style={{ width: `${e.c}%` }} />
                    <span className="bg-muted" style={{ width: `${e.f}%` }} />
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
          <p className="mt-4 text-sm text-muted">The bar under each name shows where the energy comes from: protein (teal), carbs (amber), fat (grey). Values are per 100 g.</p>
        </>
      )}
    </FilterToolbar>
  );
}
