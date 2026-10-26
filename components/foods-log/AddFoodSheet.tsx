"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { deleteEntry, loadFoodCatalog, logExtra, markMealSwapped, type FoodCatalogPayload } from "@/app/foods/log-actions";
import { ArrowLeftIcon } from "@/components/icons";
import { Sheet } from "@/components/Sheet";
import { Button, Chip, Field, Input, SearchField, Segmented } from "@/components/ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { buildCatalog, searchCatalog, type CatalogItem } from "@/lib/foods/catalog";
import type { LoggedUnit } from "@/lib/foods/units";
import { unitWord } from "@/lib/food-log/format";
import { defaultAmount, defaultSlot, previewAmount, unitsFor, type SheetFood } from "@/lib/food-log/preview";
import { SLOT_LABEL } from "@/lib/format";

export interface PersonChip {
  id: number;
  name: string;
}

export type SheetMode =
  | { kind: "add" }
  | { kind: "swap"; planSlotId: number; plannedName: string; locked: boolean };

export interface DoneResult {
  message: string;
  undo: () => Promise<string | null>;
}

const SLOTS = ["breakfast", "lunch", "dinner", "snack", "shake"] as const;
const UNIT_LABEL: Record<LoggedUnit, string> = { g: "Grams", serving: "Servings", piece: "Pieces", ml: "Millilitres" };

/** The catalog is fetched when the sheet opens; the last copy is kept so a second open shows results at once. */
let remembered: FoodCatalogPayload | null = null;

function sourceChip(food: SheetFood): string | null {
  return food.kind === "household" ? "Your food" : food.kind === "recipe" ? "Recipe" : null;
}

function per100Text(food: SheetFood): string {
  const n = food.nutrients;
  return `${Math.round(n.protein_g)} g protein, ${Math.round(n.kcal)} kcal ${food.kind === "recipe" ? "per serving" : "per 100 g"}${food.state && food.state !== "ready" ? `, ${food.state}` : ""}`;
}

export function AddFoodSheet({ open, onClose, mode, people, personId, today, yesterday, slot, date, isOwner, onDone }: {
  open: boolean;
  onClose: () => void;
  mode: SheetMode;
  people: PersonChip[];
  personId: number;
  today: string;
  yesterday: string;
  /** Preset slot, from an "Add to lunch" button. */
  slot?: string;
  /** Preset day, when Today shows yesterday. */
  date?: string;
  isOwner: boolean;
  onDone: (result: DoneResult) => void;
}) {
  const hydrated = useHydrated();
  const [catalog, setCatalog] = useState<FoodCatalogPayload | null>(remembered);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<SheetFood | null>(null);
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState<LoggedUnit>("g");
  const [slotValue, setSlotValue] = useState<string>("lunch");
  const [day, setDay] = useState(today);
  const [other, setOther] = useState(false);
  const [who, setWho] = useState<number[]>([personId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swap = mode.kind === "swap";

  useEffect(() => {
    if (!open) return;
    setQ(""); setSelected(null); setError(null); setBusy(false);
    setSlotValue(slot ?? defaultSlot(new Date().getHours() * 60 + new Date().getMinutes()));
    setDay(date ?? today); setOther(date !== undefined && date !== today && date !== yesterday);
    setWho([personId]);
    let live = true;
    void loadFoodCatalog().then((res) => {
      if (!live) return;
      if (res.ok) { remembered = res; setCatalog(res); setLoadError(null); }
      else setLoadError(res.error);
    }).catch(() => { if (live) setLoadError("Could not load foods. Try again."); });
    return () => { live = false; };
  }, [open, slot, date, today, yesterday, personId]);

  const byKey = useMemo(() => new Map((catalog?.foods ?? []).map((f) => [f.key, f])), [catalog]);
  const items = useMemo<CatalogItem[]>(() => {
    const foods = catalog?.foods ?? [];
    return buildCatalog(
      foods.filter((f) => f.kind !== "household").map((f) => ({ slug: f.key, name: f.name, aliases: f.aliases ?? [] })),
      foods.filter((f) => f.kind === "household").map((f) => ({ uid: f.key.slice(3), name: f.name, ...(f.brand ? { brand: f.brand } : {}) })),
    );
  }, [catalog]);
  const results = useMemo(() => {
    const usage = catalog?.usage ?? {};
    const found = searchCatalog(items, q, { usage, limit: 30 });
    return (q.trim() === "" ? found.filter((i) => usage[i.key]).slice(0, 8) : found).flatMap((i) => byKey.get(i.key) ?? []);
  }, [items, q, catalog, byKey]);

  function choose(food: SheetFood) {
    const start = defaultAmount(food);
    setSelected(food); setQty(String(start.qty)); setUnit(start.unit); setError(null);
  }

  const amount = Number(qty.replace(",", "."));
  const preview = selected ? previewAmount(selected, amount, unit) : null;

  async function submit() {
    if (!selected || !preview?.ok) return;
    setBusy(true); setError(null);
    const item = selected.kind === "recipe"
      ? { type: "recipe" as const, recipeSlug: selected.key.slice("recipe:".length), servings: amount }
      : selected.kind === "ingredient"
        ? { type: "ingredient" as const, ingredientSlug: selected.key, grams: preview.grams! }
        : { type: "food" as const, householdFoodUid: selected.key.slice(3), qty: amount, unit };
    if (mode.kind === "swap") {
      const res = await markMealSwapped({ personId, planSlotId: mode.planSlotId, item });
      setBusy(false);
      if (!res.ok) { setError(res.error); return; }
      const { uid } = res;
      onDone({
        message: `Logged ${selected.name} instead of ${mode.plannedName}.`,
        undo: async () => {
          const undone = await deleteEntry({ personId, uid, ...(mode.locked ? {} : { unlockSlotId: mode.planSlotId }) });
          return undone.ok ? null : undone.error;
        },
      });
      onClose();
      return;
    }
    const res = await logExtra({ personIds: who, date: day, slot: slotValue as (typeof SLOTS)[number], item });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    const { entries } = res;
    onDone({
      message: `Added ${selected.name} to ${(SLOT_LABEL[slotValue] ?? slotValue).toLowerCase()}.`,
      undo: async () => {
        for (const e of entries) {
          const undone = await deleteEntry({ personId: e.personId, uid: e.uid });
          if (!undone.ok) return undone.error;
        }
        return null;
      },
    });
    onClose();
  }

  const title = swap ? "Ate something else" : "Add food";
  return (
    <Sheet open={open} onClose={onClose} title={title} full>
      <div className="space-y-4 p-4">
        {swap ? <p className="text-sm text-muted">Instead of {mode.plannedName}. Search for what you ate.</p> : null}
        {!selected ? (
          <>
            <SearchField id={`food-search-${mode.kind}`} label="Search foods and recipes" placeholder="Search foods and recipes" value={q} onChange={setQ} />
            {loadError ? <p role="alert" className="text-sm text-bad">{loadError}</p> : null}
            {!catalog && !loadError ? <p className="text-sm text-muted">Loading foods...</p> : null}
            {catalog ? (
              <>
                {q.trim() === "" ? <p className="text-sm text-muted">{results.length ? "Recent foods" : "Type a name to search the library and your own foods."}</p> : null}
                <ul className="divide-y divide-line rounded-card border border-line">
                  {results.map((f) => (
                    <li key={f.key}>
                      <button type="button" disabled={!hydrated} onClick={() => choose(f)} className="flex min-h-12 w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface2">
                        <span className="flex flex-wrap items-center gap-2 text-base font-semibold">
                          {f.name}{f.brand ? <span className="text-sm font-normal text-muted">{f.brand}</span> : null}
                          {sourceChip(f) ? <span className="rounded-full border border-primary/40 bg-primarysoft px-2 py-0.5 text-xs font-medium text-primary">{sourceChip(f)}</span> : null}
                        </span>
                        <span className="text-sm text-muted">{per100Text(f)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {q.trim() !== "" && results.length === 0 ? <p className="text-sm text-muted">No match. Try another word.</p> : null}
                {isOwner && !catalog.hasHouseholdFoods ? (
                  <p className="rounded-card border border-dashed border-line px-3 py-3 text-sm">
                    No foods of your own yet. <Link href="/foods/new" className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline">Add a packaged food from its label</Link>
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" onClick={() => setSelected(null)} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"><ArrowLeftIcon className="size-4" />Change food</button>
            <div>
              <p className="text-lg font-semibold leading-snug">{selected.name}</p>
              <p className="text-sm text-muted">{sourceChip(selected) ? `${sourceChip(selected)}. ` : ""}{per100Text(selected)}</p>
            </div>
            {unitsFor(selected).length > 1 ? (
              <Segmented<LoggedUnit> label="Unit" value={unit} onChange={(u) => { if (u !== unit) { setUnit(u); setQty(u === "g" ? "100" : "1"); } }}
                options={unitsFor(selected).map((u) => ({ value: u, label: UNIT_LABEL[u] }))} />
            ) : null}
            <Field label={selected.kind === "recipe" ? "Servings" : `Amount in ${unitWord(unit, 2)}`} htmlFor="food-qty">
              <Input id="food-qty" inputMode="decimal" autoComplete="off" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <p aria-live="polite" data-testid="live-line" className="text-sm font-semibold tabular-nums">{preview?.ok ? preview.line : preview?.reason}</p>
            {!swap ? (
              <>
                <fieldset>
                  <legend className="mb-1 text-sm font-semibold">Meal</legend>
                  <div className="flex flex-wrap gap-2">
                    {SLOTS.map((s) => <Chip key={s} on={slotValue === s} onClick={() => setSlotValue(s)}>{SLOT_LABEL[s]}</Chip>)}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-1 text-sm font-semibold">Day</legend>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip on={!other && day === today} onClick={() => { setOther(false); setDay(today); }}>Today</Chip>
                    <Chip on={!other && day === yesterday} onClick={() => { setOther(false); setDay(yesterday); }}>Yesterday</Chip>
                    <Chip on={other} onClick={() => setOther(true)}>Another day</Chip>
                    {other ? <Input type="date" aria-label="Day" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="w-auto" /> : null}
                  </div>
                </fieldset>
                {people.length > 1 ? (
                  <fieldset>
                    <legend className="mb-1 text-sm font-semibold">Who ate it</legend>
                    <div className="flex flex-wrap gap-2">
                      {people.map((p) => (
                        <Chip key={p.id} on={who.includes(p.id)} onClick={() => setWho((cur) => (cur.includes(p.id) ? (cur.length > 1 ? cur.filter((x) => x !== p.id) : cur) : [...cur, p.id]))}>{p.name}</Chip>
                      ))}
                    </div>
                    {who.length > 1 ? <p className="mt-1 text-sm text-muted">One entry for each person, same amount.</p> : null}
                  </fieldset>
                ) : null}
              </>
            ) : null}
            {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
            <Button size="lg" className="w-full" loading={busy} disabled={!hydrated || !preview?.ok || (!swap && !day)} onClick={() => void submit()}>{swap ? "Log what I ate" : "Add"}</Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
