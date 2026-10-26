"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FoodBadges } from "@/components/foods/FoodBadges";
import { EmptyState, ResultCount, SearchField } from "@/components/ui";
import type { UsageMap } from "@/lib/foods/catalog";
import { filterFoods } from "@/lib/foods/list";
import type { FoodListItem } from "@/lib/server/food-queries";

const fmt = (n: number, digits = 1) => n.toLocaleString("en-CA", { maximumFractionDigits: digits });

/** The household's foods with search by name, brand or barcode and an archived toggle. Reading only: editing happens on a food's page. */
export function FoodsList({ foods, usage }: { foods: FoodListItem[]; usage: UsageMap }) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const active = useMemo(() => foods.filter((f) => !f.archived), [foods]);
  const archivedCount = foods.length - active.length;
  const shown = useMemo(() => filterFoods(foods, query, { includeArchived: archived, usage }), [foods, query, archived, usage]);

  return (
    <div className="space-y-3 px-4 pb-8 lg:px-2">
      <SearchField id="foods-search" label="Search your foods" placeholder="Search by name, brand or barcode" value={query} onChange={setQuery} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ResultCount shown={shown.length} total={archived ? foods.length : active.length} noun={shown.length === 1 ? "food" : "foods"} onClear={() => setQuery("")} />
        {archivedCount > 0 ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="size-5 accent-[var(--primary)]" />
            Show archived ({archivedCount})
          </label>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState title={foods.length === 0 ? "No foods yet" : "No foods match"} body={foods.length === 0 ? "Foods you add from a nutrition label appear here." : "Try a different word, or clear the search."} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((f) => (
            <li key={f.uid}>
              <Link href={`/foods/${f.uid}`} className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-4 transition-colors hover:border-primary">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold leading-snug">{f.name}</h2>
                  {f.brand ? <p className="text-sm text-muted">{f.brand}</p> : null}
                </div>
                <p className="text-sm tabular-nums">
                  <span className="text-muted">Per 100 g: </span>
                  <strong>{fmt(f.kcal, 0)} kcal</strong>, protein {fmt(f.proteinG)} g, carbs {fmt(f.carbsG)} g, fat {fmt(f.fatG)} g,{" "}
                  {f.fibreG === null ? "fibre not reported" : `fibre ${fmt(f.fibreG)} g`}
                </p>
                <FoodBadges source={f.source} estimatedWeight={f.estimatedWeight} archived={f.archived} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
