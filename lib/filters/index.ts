import { z } from "zod";

/**
 * Filter system shared by every list. A list describes its filters once (`defineFilters`); everything else is pure:
 * parsing and writing the URL query, applying the filters, and counting what each option would give.
 * No React in this file, so it is cheap to test.
 */

export interface FilterOption<T> {
  value: string;
  label: string;
  test: (item: T) => boolean;
}

export interface FacetDef<T> {
  key: string;
  label: string;
  /** single: at most one option. multi: any number, combined with `combine`. */
  mode: "single" | "multi";
  /** How several selected options combine in a multi facet. Defaults to "and". */
  combine?: "and" | "or";
  /** Inclusive facets add items (for example "show hidden") instead of restricting them; `visible` reads them. */
  inclusive?: boolean;
  options: FilterOption<T>[];
}

export interface SortDef<T> {
  value: string;
  label: string;
  compare: (a: T, b: T) => number;
}

export interface PresetDef {
  id: string;
  label: string;
  sel?: Record<string, string[]>;
  sort?: string;
}

export interface FilterDef<T> {
  /** Text a search can match. The first entry is the name (ranked highest); then aliases, family, tags and so on. Every search word must appear. */
  search: (item: T) => string[];
  sorts: SortDef<T>[];
  defaultSort: string;
  facets: FacetDef<T>[];
  presets: PresetDef[];
  /** Base visibility, before any restricting filter. Lets inclusive facets bring items back. */
  visible?: (item: T, state: FilterState) => boolean;
}

export interface FilterState {
  q: string;
  sort: string;
  sel: Record<string, string[]>;
}

/** Marker written when the user clears everything while a saved default exists, so the default does not snap back. */
export const NO_DEFAULT_PARAM = "v";

export function defineFilters<T>(def: FilterDef<T>): FilterDef<T> {
  const keys = def.facets.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new Error("filter facet keys must be unique");
  if (keys.some((k) => k === "q" || k === "sort" || k === NO_DEFAULT_PARAM)) throw new Error("filter facet key clashes with a reserved parameter");
  if (!def.sorts.some((s) => s.value === def.defaultSort)) throw new Error(`unknown default sort "${def.defaultSort}"`);
  for (const f of def.facets) {
    const vals = f.options.map((o) => o.value);
    if (new Set(vals).size !== vals.length || vals.some((v) => v === "" || v.includes(","))) throw new Error(`facet "${f.key}" has invalid option values`);
  }
  for (const p of def.presets) {
    if (p.sort && !def.sorts.some((s) => s.value === p.sort)) throw new Error(`preset "${p.id}" uses an unknown sort`);
    for (const [k, vals] of Object.entries(p.sel ?? {})) {
      const f = def.facets.find((x) => x.key === k);
      if (!f || vals.some((v) => !f.options.some((o) => o.value === v))) throw new Error(`preset "${p.id}" uses an unknown filter value`);
    }
  }
  return def;
}

export function defaultState<T>(def: FilterDef<T>): FilterState {
  return { q: "", sort: def.defaultSort, sel: Object.fromEntries(def.facets.map((f) => [f.key, []])) };
}

type ParamsLike = URLSearchParams | string | Record<string, string | string[] | undefined>;

function toParams(input: ParamsLike): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === "string") return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined) p.set(k, first);
  }
  return p;
}

/** Reads a query into a state. Anything unknown or invalid is dropped, so a bad link shows the default list. */
export function parseFilterParams<T>(def: FilterDef<T>, input: ParamsLike): FilterState {
  const params = toParams(input);
  const shape: Record<string, z.ZodTypeAny> = {
    q: z.string().max(100).catch(""),
    sort: z.enum(def.sorts.map((s) => s.value) as [string, ...string[]]).catch(def.defaultSort),
  };
  for (const f of def.facets) shape[f.key] = z.string().max(300).catch("");
  const parsed = z.object(shape).parse(Object.fromEntries([...Object.keys(shape)].map((k) => [k, params.get(k) ?? undefined]))) as Record<string, string | undefined>;

  const sel: Record<string, string[]> = {};
  for (const f of def.facets) {
    const valid = new Set(f.options.map((o) => o.value));
    const picked = [...new Set((parsed[f.key] ?? "").split(",").map((v) => v.trim()).filter((v) => valid.has(v)))];
    sel[f.key] = f.mode === "single" ? picked.slice(0, 1) : picked;
  }
  return { q: (parsed.q ?? "").trim(), sort: parsed.sort ?? def.defaultSort, sel };
}

/** Writes a state as a query string with no leading "?". Defaults are left out, so the plain list has a plain URL. */
export function serializeFilterState<T>(def: FilterDef<T>, state: FilterState): string {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.sort !== def.defaultSort) p.set("sort", state.sort);
  for (const f of def.facets) {
    const vals = state.sel[f.key] ?? [];
    if (vals.length) p.set(f.key, vals.join(","));
  }
  return p.toString().replace(/%2C/g, ",");
}

/** True when a query already says something about filtering, including the "no default" marker. */
export function hasFilterParams<T>(def: FilterDef<T>, input: ParamsLike): boolean {
  const params = toParams(input);
  return ["q", "sort", NO_DEFAULT_PARAM, ...def.facets.map((f) => f.key)].some((k) => params.has(k));
}

/** The query to use on first load: the saved default only when the URL says nothing of its own. */
export function resolveInitialQuery<T>(def: FilterDef<T>, urlQuery: string, savedDefault: string | null): string {
  return savedDefault && !hasFilterParams(def, urlQuery) ? savedDefault : urlQuery;
}

function facetOk<T>(f: FacetDef<T>, item: T, selected: string[]): boolean {
  if (f.inclusive || selected.length === 0) return true;
  const opts = selected.map((v) => f.options.find((o) => o.value === v)).filter((o): o is FilterOption<T> => !!o);
  if (opts.length === 0) return true;
  if (f.mode === "single") return opts[0]!.test(item);
  return f.combine === "or" ? opts.some((o) => o.test(item)) : opts.every((o) => o.test(item));
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "tomatoes" and "tomato", "lentils" and "lentil" should find each other. */
function variants(word: string): string[] {
  const out = [word];
  if (word.length > 3 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}

/**
 * How well an item matches a search, or null when it does not match. Every word must match somewhere. The first
 * field `search` returns is the name and counts most; later fields (aliases, cuisine, tags, ingredients) count less.
 * Whole words beat word starts, which beat matches inside a word, so "pea" lists "Pea soup" before "Chickpea salad".
 */
export function searchScore<T>(def: FilterDef<T>, item: T, q: string): number | null {
  const qn = norm(q);
  if (!qn) return 0;
  const [first = "", ...rest] = def.search(item).map(norm);
  const nameWords = first.split(" ");
  const restWords = rest.flatMap((f) => f.split(" "));
  const restText = rest.join(" ");
  let total = 0;
  for (const w of qn.split(" ")) {
    let best = 0;
    for (const v of variants(w)) {
      let s = 0;
      if (nameWords.includes(v)) s = 50;
      else if (nameWords.some((x) => x.startsWith(v))) s = 40;
      else if (first.includes(v)) s = 25;
      else if (restWords.includes(v)) s = 20;
      else if (restWords.some((x) => x.startsWith(v))) s = 15;
      else if (restText.includes(v)) s = 8;
      best = Math.max(best, s);
    }
    if (best === 0) return null;
    total += best;
  }
  if (first === qn) total += 100;
  else if (first.startsWith(qn)) total += 30;
  else if (first.includes(qn)) total += 15;
  return total;
}

function searchOk<T>(def: FilterDef<T>, item: T, q: string): boolean {
  return searchScore(def, item, q) !== null;
}

function passes<T>(def: FilterDef<T>, item: T, state: FilterState, skipFacet?: string): boolean {
  if (def.visible && !def.visible(item, state)) return false;
  if (!searchOk(def, item, state.q)) return false;
  return def.facets.every((f) => f.key === skipFacet || facetOk(f, item, state.sel[f.key] ?? []));
}

export function applyFilters<T>(def: FilterDef<T>, items: readonly T[], state: FilterState): T[] {
  const sort = def.sorts.find((s) => s.value === state.sort) ?? def.sorts.find((s) => s.value === def.defaultSort)!;
  const kept = items.filter((i) => passes(def, i, state));
  if (!norm(state.q)) return kept.sort(sort.compare);
  // With a search, the best match comes first and the chosen sort breaks ties.
  const score = new Map(kept.map((i) => [i, searchScore(def, i, state.q) ?? 0]));
  return kept.sort((a, b) => score.get(b)! - score.get(a)! || sort.compare(a, b));
}

/** How many items pass base visibility alone: the "of N" in "41 of 99 recipes". Search and filters are ignored. */
export function visibleCount<T>(def: FilterDef<T>, items: readonly T[], state: FilterState): number {
  return def.visible ? items.filter((i) => def.visible!(i, state)).length : items.length;
}

/**
 * For every option, how many items would be shown if that option were chosen, given everything else that is active.
 * Restricting facets ignore their own selection (so a chosen option does not hide its siblings); inclusive facets
 * count what choosing the option would bring in.
 */
export function facetCounts<T>(def: FilterDef<T>, items: readonly T[], state: FilterState): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const f of def.facets) {
    out[f.key] = {};
    for (const o of f.options) {
      const st: FilterState = f.inclusive
        ? { ...state, sel: { ...state.sel, [f.key]: [...new Set([...(state.sel[f.key] ?? []), o.value])] } }
        : state;
      let n = 0;
      for (const item of items) {
        if (o.test(item) && passes(def, item, st, f.inclusive ? undefined : f.key)) n++;
      }
      out[f.key]![o.value] = n;
    }
  }
  return out;
}

export interface ActiveChip {
  facet: string;
  value: string;
  label: string;
}

export function activeChips<T>(def: FilterDef<T>, state: FilterState): ActiveChip[] {
  return def.facets.flatMap((f) =>
    (state.sel[f.key] ?? []).flatMap((v) => {
      const o = f.options.find((x) => x.value === v);
      return o ? [{ facet: f.key, value: v, label: f.inclusive ? `Showing ${o.label.toLowerCase()}` : o.label }] : [];
    }),
  );
}

export function activeFilterCount<T>(def: FilterDef<T>, state: FilterState): number {
  return activeChips(def, state).length;
}

export function isDefaultState<T>(def: FilterDef<T>, state: FilterState): boolean {
  return serializeFilterState(def, state) === "";
}

/** Toggle one option. Single facets replace their value (and clear it when it is chosen again). */
export function toggleOption<T>(def: FilterDef<T>, state: FilterState, facetKey: string, value: string): FilterState {
  const f = def.facets.find((x) => x.key === facetKey);
  if (!f || !f.options.some((o) => o.value === value)) return state;
  const cur = state.sel[facetKey] ?? [];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : f.mode === "single" ? [value] : [...cur, value];
  return { ...state, sel: { ...state.sel, [facetKey]: next } };
}

export function clearFilters<T>(def: FilterDef<T>, state: FilterState): FilterState {
  return { ...defaultState(def), q: state.q, sort: state.sort };
}

export function applyPreset<T>(def: FilterDef<T>, presetId: string, state: FilterState): FilterState {
  const p = def.presets.find((x) => x.id === presetId);
  if (!p) return state;
  const base = defaultState(def);
  return { q: state.q, sort: p.sort ?? state.sort, sel: { ...base.sel, ...(p.sel ?? {}) } };
}

export function presetIsActive<T>(def: FilterDef<T>, presetId: string, state: FilterState): boolean {
  const p = def.presets.find((x) => x.id === presetId);
  if (!p) return false;
  const want = applyPreset(def, presetId, { ...defaultState(def), sort: state.sort });
  const same = def.facets.every((f) => {
    const a = [...(want.sel[f.key] ?? [])].sort().join(",");
    const b = [...(state.sel[f.key] ?? [])].sort().join(",");
    return a === b;
  });
  return same && (!p.sort || p.sort === state.sort);
}
