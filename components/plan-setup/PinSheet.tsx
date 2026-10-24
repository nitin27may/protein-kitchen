"use client";

import { useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Chip, ResultCount, SearchField, SortMenu } from "@/components/ui";
import { filterPickRecipes, PICK_DEFAULT, PICK_SORTS, pickIsFiltered } from "@/lib/filters/lists";
import type { PickSort } from "@/lib/filters/lists";
import { MEALS } from "./constants";
import type { PinRecipe } from "./types";

/** Choose recipes to place once each across the plan. Search, meal type and sort, as before. */
export function PinSheet({ open, onClose, recipes, pinned, onChange }: { open: boolean; onClose: () => void; recipes: PinRecipe[]; pinned: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState("");
  const [meal, setMeal] = useState("all");
  const [sort, setSort] = useState<PickSort>("protein");

  const state = { ...PICK_DEFAULT, q, meal, sort };
  const all = filterPickRecipes(recipes, state);
  const shown = all.slice(0, 60);

  return (
    <Sheet open={open} onClose={onClose} title="Pin recipes">
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="pin-search" label="Search recipes" value={q} onChange={setQ} placeholder="Search recipes" className="min-w-[12rem] flex-1" />
          <SortMenu value={sort} onChange={(v) => setSort(v as PickSort)} options={PICK_SORTS} />
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Meal type">
          <Chip on={meal === "all"} onClick={() => setMeal("all")}>All meals</Chip>
          {MEALS.map((m) => <Chip key={m.id} on={meal === m.id} onClick={() => setMeal(meal === m.id ? "all" : m.id)}>{m.label}</Chip>)}
        </div>
        <div className="mt-2"><ResultCount shown={all.length} total={recipes.length} noun="recipes" onClear={pickIsFiltered(state) ? () => { setQ(""); setMeal("all"); } : undefined} /></div>
        {pinned.length ? <p className="mt-1 text-sm text-muted">{pinned.length} pinned</p> : null}
        {all.length > shown.length ? <p className="mt-1 text-sm text-muted">Showing the first {shown.length}. Search or filter to see the rest.</p> : null}
        <ul className="mt-2 divide-y divide-line">
          {shown.map((r) => {
            const on = pinned.includes(r.slug);
            return (
              <li key={r.slug}>
                <button type="button" aria-pressed={on} onClick={() => onChange(on ? pinned.filter((x) => x !== r.slug) : [...pinned, r.slug])} className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left">
                  <span><span className="block font-medium">{r.name}</span><span className="text-xs text-muted">{Math.round(r.proteinG)} g protein per serving, {r.activeMin} min</span></span>
                  <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-primary bg-primarysoft text-primary" : "border-strong text-muted"}`}>{on ? "Pinned" : "Pin"}</span>
                </button>
              </li>
            );
          })}
          {shown.length === 0 ? <li className="p-4 text-center text-muted">Nothing matches. Clear a filter to see more.</li> : null}
        </ul>
      </div>
    </Sheet>
  );
}
