"use client";

import { useState } from "react";
import { deleteEntry, logExtra, updateEntry } from "@/app/foods/log-actions";
import { Button, Input } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import type { EntryView } from "@/lib/food-log/day-view";
import { useFoodLog } from "./FoodLogProvider";

type Item = NonNullable<EntryView["item"]>;

/** The item as the add action takes it, with a new amount. */
function withAmount(item: Item, amount: number) {
  if (item.type === "recipe") return { type: "recipe" as const, recipeSlug: item.recipeSlug, servings: amount };
  if (item.type === "ingredient") return { type: "ingredient" as const, ingredientSlug: item.ingredientSlug, grams: amount };
  return { type: "food" as const, householdFoodUid: item.householdFoodUid, qty: amount, unit: "g" as const };
}

/** One logged item: what, how much, what it adds. Edit changes the amount; Delete has an Undo. */
export function EntryRow({ entry, canEdit }: { entry: EntryView; canEdit: boolean }) {
  const hydrated = useHydrated();
  const { show, refresh } = useFoodLog();
  const [editing, setEditing] = useState(false);
  const item = entry.item;
  const current = item === null ? 0 : item.type === "recipe" ? item.servings : item.grams;
  const [value, setValue] = useState(String(Math.round(current * 10) / 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!item) return;
    setBusy(true); setError(null);
    const res = await updateEntry({ personId: entry.personId, uid: entry.uid, item: withAmount(item, Number(value.replace(",", "."))) });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setEditing(false);
    refresh();
  }

  async function remove() {
    setBusy(true); setError(null);
    const res = await deleteEntry({ personId: entry.personId, uid: entry.uid });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    show(`Removed ${entry.name}.`, entry.kind === "extra" && item ? async () => {
      const back = await logExtra({ personIds: [entry.personId], date: entry.date, slot: entry.slot as "lunch", item: withAmount(item, current) });
      return back.ok ? null : back.error;
    } : undefined);
    refresh();
  }

  const unit = item?.type === "recipe" ? "servings" : "grams";
  return (
    <li className="px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold leading-snug">{entry.name}</p>
          <p className="text-sm text-muted tabular-nums">
            {entry.kind === "swap" && entry.plannedName ? `Instead of ${entry.plannedName}. ` : ""}
            {entry.resolved ? `${entry.amount} · ${Math.round(entry.proteinG)} g protein · ${Math.round(entry.kcal)} kcal` : `${entry.amount} · not counted, the food is no longer available`}
          </p>
        </div>
        {canEdit && item ? <Button variant="ghost" size="sm" disabled={!hydrated} onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit"}</Button> : null}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold" htmlFor={`amount-${entry.uid}`}>Amount in {unit}
            <Input id={`amount-${entry.uid}`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 w-32" />
          </label>
          <Button size="sm" loading={busy} onClick={() => void save()}>Save</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>Delete</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-sm text-bad">{error}</p> : null}
    </li>
  );
}
