"use client";

import { useMemo, useState, useTransition } from "react";
import { clearDefaultView, saveDefaultView } from "@/app/actions";
import { useRequireAccount } from "@/components/auth/RequireAccount";
import { Sheet } from "@/components/Sheet";
import { ActiveFilters, Banner, Button, FilterButton, FilterSection, ListToolbar, PresetChips, SearchField, SortMenu } from "@/components/ui";
import { activeChips, activeFilterCount, applyFilters, facetCounts, isDefaultState, presetIsActive, visibleCount } from "@/lib/filters";
import type { FilterDef } from "@/lib/filters";
import { useUrlFilters } from "@/lib/filters/use-url-filters";

/**
 * Search, sort, Filters button, active-filter chips and the filter drawer for one list. It owns the filter state (kept
 * in the URL) and hands the filtered items to `children`, so a list only has to draw its own results.
 */
export function FilterToolbar<T>({ list, def, items, savedDefault, canSaveView = true, noun, searchLabel, searchPlaceholder, children }: {
  list: string;
  def: FilterDef<T>;
  items: readonly T[];
  savedDefault: string | null;
  /** False hides the saved-view controls. A visitor without an account sees them and is asked to sign up when they save. */
  canSaveView?: boolean;
  noun: { one: string; many: string };
  searchLabel: string;
  searchPlaceholder: string;
  children: (shown: T[], tools: { clear: () => void }) => React.ReactNode;
}) {
  const f = useUrlFilters(def, savedDefault);
  const gate = useRequireAccount();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const shown = useMemo(() => applyFilters(def, items, f.state), [def, items, f.state]);
  const total = visibleCount(def, items, f.state);
  const counts = useMemo(() => facetCounts(def, items, f.state), [def, items, f.state]);
  const chips = activeChips(def, f.state);
  const nFilters = activeFilterCount(def, f.state);
  const presets = def.presets.map((p) => ({ id: p.id, label: p.label, active: presetIsActive(def, p.id, f.state) }));
  const nounFor = (n: number) => (n === 1 ? noun.one : noun.many);
  const savedIsCurrent = savedDefault !== null && savedDefault === f.query;

  const saveDefault = () => {
    if (gate.require({ intent: { kind: "other", action: "saving your default view" } })) return;
    start(async () => {
      const r = await saveDefaultView(list, f.query);
      setNote(r.ok ? "Saved. This view opens first next time." : r.error);
    });
  };
  const removeDefault = () =>
    start(async () => {
      const r = await clearDefaultView(list);
      setNote(r.ok ? "Default view removed." : r.error);
    });

  return (
    <div className="px-4 pb-8">
      <ListToolbar>
        <SearchField id={`${list}-search`} label={searchLabel} value={f.state.q} onChange={f.setSearch} placeholder={searchPlaceholder} className="min-w-[14rem] flex-1 lg:max-w-xl" />
        <SortMenu value={f.state.sort} onChange={f.setSort} options={def.sorts.map((s) => ({ value: s.value, label: s.label }))} />
        <FilterButton count={nFilters} expanded={open} onClick={() => { setNote(null); setOpen(true); }} />
      </ListToolbar>

      <ActiveFilters chips={chips} onRemove={f.toggle} onClear={f.clear} presets={presets} onPreset={f.applyPreset} shown={shown.length} total={total} noun={nounFor(shown.length)} />

      {shown.length === 0 ? (
        <div className="mt-4 rounded-card border border-dashed border-line bg-surface p-8 text-center">
          <p className="font-semibold">No {noun.many} match.</p>
          <p className="mt-1 text-sm text-muted">Loosen a filter or search for something else.</p>
          <Button variant="secondary" className="mt-3" onClick={f.clear}>Clear filters</Button>
        </div>
      ) : (
        children(shown, { clear: f.clear })
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Filters" side="right">
        <div className="flex min-h-full flex-col">
          <div className="flex-1 space-y-5 p-4 lg:p-5">
            <PresetChips presets={presets} onApply={f.applyPreset} />
            {def.facets.map((facet) => (
              <FilterSection
                key={facet.key}
                title={facet.label}
                options={facet.options.map((o) => ({ value: o.value, label: o.label, count: counts[facet.key]?.[o.value] ?? 0, selected: (f.state.sel[facet.key] ?? []).includes(o.value) }))}
                onToggle={(v) => f.toggle(facet.key, v)}
              />
            ))}
            {canSaveView ? <div className="space-y-2 border-t border-line pt-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={saveDefault} loading={pending} disabled={isDefaultState(def, f.state) || savedIsCurrent}>Save as my default</Button>
                {savedDefault !== null ? <Button variant="ghost" size="sm" onClick={removeDefault} disabled={pending}>Remove default</Button> : null}
              </div>
              <p className="text-xs text-muted">The default opens whenever this list loads without filters in its link.</p>
              {note ? <Banner tone="ok">{note}</Banner> : null}
            </div> : null}
          </div>
          <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-surface p-3 lg:px-5" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
            <Button variant="ghost" size="sm" onClick={f.clear} disabled={nFilters === 0}>Clear all</Button>
            <Button onClick={() => setOpen(false)} className="min-w-40">Show {shown.length} {nounFor(shown.length)}</Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
