"use client";

import { IngredientTile } from "@/components/IngredientTile";
import { useEffect, useMemo, useState } from "react";
import { addManualItem, removeManualItem, setGroceryChecked, setManualChecked } from "@/app/actions";
import { CheckIcon, PlusIcon, XIcon } from "@/components/icons";
import { Banner, Button, Chip, Input, SearchField } from "@/components/ui";
import { filterGroceryLines } from "@/lib/filters/lists";
import { aisleLabel, grams } from "@/lib/format";

export interface GroceryLineView {
  slug: string;
  name: string;
  state: string;
  aisle: string;
  image: string | null;
  needG: number;
  buyG: number;
  packs: number | null;
  pantry: boolean;
  recipes: string[];
  checked: boolean;
}

export interface GroceryProps {
  planId: number;
  rangeLabel: string;
  weeks: { label: string; href: string; active: boolean }[];
  lines: GroceryLineView[];
  singleUse: number;
  manual: { id: number; text: string; checked: boolean }[];
}

const labelFor = aisleLabel;

function lineText(l: GroceryLineView): string {
  const amount = l.packs ? `${l.packs} × pack (${grams(l.buyG)})` : grams(l.buyG);
  const state = l.state === "dry" ? " (dry)" : l.state === "cooked" ? " (cooked)" : "";
  return `${l.name}${state}: ${amount}`;
}

function storageKey(planId: number) {
  return `pk-grocery-${planId}`;
}

export function GroceryClient(p: GroceryProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(p.lines.map((l) => [l.slug, l.checked])));
  const [manual, setManual] = useState(p.manual);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const [offlineQueue, setOfflineQueue] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [hideTicked, setHideTicked] = useState(false);

  // Restore anything ticked while offline and try to sync it.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(p.planId));
      if (!raw) return;
      const q = JSON.parse(raw) as Record<string, boolean>;
      if (Object.keys(q).length === 0) return;
      setChecked((c) => ({ ...c, ...q }));
      setOfflineQueue(q);
    } catch {
      /* storage can be unavailable in private windows */
    }
  }, [p.planId]);

  useEffect(() => {
    const flush = async () => {
      const entries = Object.entries(offlineQueue);
      if (entries.length === 0 || !navigator.onLine) return;
      try {
        for (const [slug, v] of entries) {
          const r = await setGroceryChecked(p.planId, slug, v);
          if (!r.ok) return;
        }
        setOfflineQueue({});
        localStorage.removeItem(storageKey(p.planId));
        setNote({ tone: "ok", text: "Synced the items you ticked offline." });
      } catch {
        /* still offline; keep the queue */
      }
    };
    void flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [offlineQueue, p.planId]);

  async function tick(slug: string, value: boolean) {
    setChecked((c) => ({ ...c, [slug]: value }));
    try {
      const r = await setGroceryChecked(p.planId, slug, value);
      if (!r.ok) throw new Error(r.error);
    } catch {
      const q = { ...offlineQueue, [slug]: value };
      setOfflineQueue(q);
      try {
        localStorage.setItem(storageKey(p.planId), JSON.stringify(q));
      } catch {
        /* ignore */
      }
      setNote({ tone: "info", text: "No connection. Saved on this phone and will sync later." });
    }
  }

  // Groups feed Share and Copy too, so they stay unfiltered; `visibleGroups` is what the list shows.
  const groups = useMemo(() => {
    const by = new Map<string, GroceryLineView[]>();
    for (const l of p.lines.filter((x) => !x.pantry)) by.set(l.aisle, [...(by.get(l.aisle) ?? []), l]);
    return [...by.entries()].sort((a, b) => labelFor(a[0]).localeCompare(labelFor(b[0])));
  }, [p.lines]);
  const visibleGroups = groups
    .map(([aisle, ls]) => [aisle, filterGroceryLines(ls, { q, hideTicked }, (s) => !!checked[s])] as const)
    .filter(([, ls]) => ls.length > 0);
  const narrowed = q.trim() !== "" || hideTicked;
  const visibleCount = visibleGroups.reduce((n, [, ls]) => n + ls.length, 0);
  const pantry = p.lines.filter((l) => l.pantry);
  const open = p.lines.filter((l) => !l.pantry && !checked[l.slug]);
  const total = p.lines.filter((l) => !l.pantry).length;
  const done = total - open.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  function shareText(): string {
    const lines = groups.flatMap(([, ls]) => ls.filter((l) => !checked[l.slug]).map(lineText));
    const extra = manual.filter((m) => !m.checked).map((m) => m.text);
    return [...lines, ...extra].join("\n");
  }

  async function copy() {
    const t = shareText();
    try {
      await navigator.clipboard.writeText(t);
      setNote({ tone: "ok", text: "Copied. Paste it into Reminders or Keep and each line becomes an item." });
    } catch {
      setNote({ tone: "bad", text: "Could not copy. Long-press the list and copy it by hand." });
    }
  }

  // navigator.share must run straight from the tap, before any await.
  function share() {
    const t = shareText();
    if (typeof navigator.share === "function") {
      navigator.share({ title: "Grocery list", text: t }).catch(() => undefined);
    } else {
      void copy();
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const r = await addManualItem(p.planId, text);
    if (!r.ok) return setNote({ tone: "bad", text: r.error });
    setManual((m) => [...m, { id: r.id, text: text.trim(), checked: false }]);
    setText("");
  }

  return (
    <div className="px-4 pb-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      {/* Side panel: sticky on desktop, a summary block above the list on phones. */}
      <aside aria-label="Shopping summary" className="space-y-4 lg:sticky lg:top-4 lg:order-2">
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="text-sm text-muted">{p.rangeLabel}</p>
          <p className="mt-2 font-display text-4xl font-bold tabular-nums leading-none">{open.length}<span className="ml-2 text-base font-medium text-muted">to buy</span></p>
          <div role="progressbar" aria-label="Items ticked" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface2">
            <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-sm text-muted">{done} of {total} ticked</p>

          <div className="mt-4 space-y-3">
            <SearchField id="grocery-q" label="Search the list" value={q} onChange={setQ} placeholder="Search the list" />
            <div className="flex flex-wrap items-center gap-2">
              <Chip on={hideTicked} onClick={() => setHideTicked((v) => !v)}>Hide ticked</Chip>
              {narrowed ? <button type="button" onClick={() => { setQ(""); setHideTicked(false); }} className="min-h-11 px-1 text-sm font-semibold text-primary underline-offset-2 hover:underline lg:min-h-9">Clear filters</button> : null}
            </div>
            {narrowed ? <p className="text-sm text-muted" aria-live="polite">{visibleCount} of {total} items shown</p> : null}
          </div>

          {groups.length > 1 ? (
            <nav aria-label="Jump to an aisle" className="mt-4 hidden lg:block">
              <p className="mb-1.5 text-sm font-semibold">Jump to</p>
              <ul className="flex flex-wrap gap-1.5">
                {visibleGroups.map(([aisle, ls]) => (
                  <li key={aisle}><a href={`#a-${aisle}`} className="inline-flex min-h-9 items-center rounded-full border border-strong bg-surface px-3 text-sm font-semibold hover:bg-surface2">{labelFor(aisle)} <span className="ml-1 text-xs font-medium tabular-nums text-muted">{ls.length}</span></a></li>
                ))}
              </ul>
            </nav>
          ) : null}

          {p.weeks.length > 1 ? (
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-semibold">Shop by week</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Shop by week">
                {p.weeks.map((w) => (
                  <a key={w.href} href={w.href} aria-current={w.active ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold lg:min-h-9 ${w.active ? "border-primary bg-primarysoft text-primary" : "border-strong bg-surface hover:bg-surface2"}`}>
                    {w.active ? <CheckIcon className="size-4" /> : null}{w.label}
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={share}>Share</Button>
            <Button variant="secondary" onClick={copy}>Copy list</Button>
          </div>
          {p.singleUse >= 12 ? <p className="mt-3 text-sm text-muted">{p.singleUse} items are used in only one recipe. Swapping one meal for something that shares ingredients shortens the list.</p> : null}
        </div>
        {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      </aside>

      <div className="mt-4 lg:order-1 lg:mt-0">
        {total === 0 ? <p className="rounded-card border border-dashed border-line bg-surface p-6 text-center text-muted">Nothing to buy for these days. Pick a different week or make a plan.</p> : null}
        {total > 0 && visibleGroups.length === 0 ? <p className="rounded-card border border-dashed border-line bg-surface p-6 text-center text-muted">Nothing matches. Clear the search or show ticked items.</p> : null}
        {visibleGroups.length > 1 ? (
          <nav aria-label="Jump to an aisle" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
            {visibleGroups.map(([aisle, ls]) => (
              <a key={aisle} href={`#a-${aisle}`} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-strong bg-surface px-3.5 text-sm font-semibold">{labelFor(aisle)} <span className="ml-1 text-xs font-medium tabular-nums text-muted">{ls.length}</span></a>
            ))}
          </nav>
        ) : null}
        <div className="space-y-5 lg:columns-2 lg:gap-6 lg:space-y-0 2xl:columns-3 [&>*]:lg:mb-5 [&>*]:lg:break-inside-avoid">
          {visibleGroups.map(([aisle, ls]) => (
            <section key={aisle} aria-labelledby={`a-${aisle}`} className="scroll-mt-4">
              <h2 id={`a-${aisle}`} className="mb-1.5 flex scroll-mt-4 items-baseline justify-between text-base font-semibold">
                {labelFor(aisle)}<span className="text-sm font-normal text-muted tabular-nums">{ls.filter((l) => !checked[l.slug]).length} left</span>
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                {ls.map((l) => (
                  <li key={l.slug}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface2">
                      <input type="checkbox" checked={!!checked[l.slug]} onChange={(e) => tick(l.slug, e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
                      {l.image ? <img src={l.image} alt="" loading="lazy" className="size-10 shrink-0 rounded-control object-cover" /> : <IngredientTile aisle={aisle} className="size-10 shrink-0 rounded-control" />}
                      <span className="min-w-0 flex-1">
                        <span className={`block text-base font-medium leading-snug ${checked[l.slug] ? "text-muted line-through" : ""}`}>{l.name}{l.state === "dry" ? <span className="text-sm font-normal text-muted"> (dry)</span> : null}</span>
                        <span className="block truncate text-xs text-muted">for {l.recipes.join(", ")}</span>
                      </span>
                      <span className="shrink-0 text-right text-base font-semibold tabular-nums">{l.packs ? `${l.packs} pack${l.packs > 1 ? "s" : ""}` : grams(l.buyG)}{l.packs ? <span className="block text-xs font-normal text-muted">{grams(l.buyG)}</span> : null}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section aria-labelledby="mine">
            <h2 id="mine" className="mb-1.5 text-base font-semibold">Your items</h2>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {manual.length ? (
                <ul className="divide-y divide-line">
                  {manual.map((m) => (
                    <li key={m.id} className="flex min-h-14 items-center gap-3 px-3">
                      <input aria-label={m.text} type="checkbox" checked={m.checked} onChange={async (e) => { const v = e.target.checked; setManual((c) => c.map((x) => (x.id === m.id ? { ...x, checked: v } : x))); await setManualChecked(m.id, v); }} className="size-6 shrink-0 accent-[var(--primary)]" />
                      <span className={`flex-1 text-base ${m.checked ? "text-muted line-through" : ""}`}>{m.text}</span>
                      <button type="button" aria-label={`Remove ${m.text}`} onClick={async () => { setManual((c) => c.filter((x) => x.id !== m.id)); await removeManualItem(m.id); }} className="flex size-11 items-center justify-center rounded-control text-muted hover:bg-surface2 hover:text-fg lg:size-9"><XIcon className="size-4" /></button>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-3 py-3 text-sm text-muted">Anything not in the plan, such as dish soap or fruit. Add it below.</p>}
              <form onSubmit={add} className="flex gap-2 border-t border-line p-2">
                <label htmlFor="manual" className="sr-only">Add an item</label>
                <Input id="manual" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item" maxLength={120} className="flex-1" />
                <Button type="submit" disabled={!text.trim()}><PlusIcon className="size-4" />Add</Button>
              </form>
            </div>
          </section>

          {pantry.length ? (
            <details className="rounded-card border border-line bg-surface">
              <summary className="flex min-h-12 cursor-pointer items-center px-3 text-base font-semibold">Check pantry ({pantry.length})</summary>
              <ul className="divide-y divide-line border-t border-line">
                {pantry.map((l) => (
                  <li key={l.slug} className="flex min-h-12 items-center justify-between gap-3 px-3 py-1 text-base">
                    <label className="flex flex-1 cursor-pointer items-center gap-3">
                      <input type="checkbox" checked={!!checked[l.slug]} onChange={(e) => tick(l.slug, e.target.checked)} className="size-6 accent-[var(--primary)]" />
                      <span className={checked[l.slug] ? "text-muted line-through" : ""}>{l.name}</span>
                    </label>
                    <span className="tabular-nums text-muted">{grams(l.needG)}</span>
                  </li>
                ))}
              </ul>
              <p className="px-3 py-2 text-xs text-muted">Tick what you already have. Spices, oil and salt are hidden by default.</p>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
