"use client";

import { IngredientTile } from "@/components/IngredientTile";
import { useMemo, useState } from "react";
import { CheckIcon, MinusIcon, XIcon } from "@/components/icons";
import { Sheet } from "@/components/Sheet";
import { Button, Chip, SearchField, Segmented } from "@/components/ui";
import { pickerChips } from "@/lib/filters/lists";

export interface PickerIngredient {
  slug: string;
  name: string;
  aliases: string[];
  group: string;
  /** Aisle slug, for the tile shown when there is no photo. */
  aisle: string;
  /** Protein per 100 kcal, to help people spot protein-dense foods. */
  density: number;
  image: string | null;
}

export type PrefState = "none" | "like" | "avoid";
export interface PrefSet {
  liked: string[];
  avoided: string[];
}

export function stateOf(p: PrefSet, slug: string): PrefState {
  return p.liked.includes(slug) ? "like" : p.avoided.includes(slug) ? "avoid" : "none";
}

export function setState(p: PrefSet, slug: string, to: PrefState): PrefSet {
  const liked = p.liked.filter((s) => s !== slug);
  const avoided = p.avoided.filter((s) => s !== slug);
  if (to === "like") liked.push(slug);
  if (to === "avoid") avoided.push(slug);
  return { liked, avoided };
}

export function nextState(p: PrefSet, slug: string): PrefSet {
  const cur = stateOf(p, slug);
  return setState(p, slug, cur === "none" ? "like" : cur === "like" ? "avoid" : "none");
}

export const STATE_LABEL: Record<PrefState, string> = { none: "Neutral", like: "Like", avoid: "Avoid" };

/** Quick staple chip: tap cycles neutral, like, avoid. The icon and word state the current choice. */
export function PrefChip({ name, state, onClick }: { name: string; state: PrefState; onClick: () => void }) {
  const style = state === "like" ? "border-ok bg-oksoft text-ok" : state === "avoid" ? "border-bad bg-badsoft text-bad" : "border-strong bg-surface text-fg hover:bg-surface2";
  return (
    <button type="button" onClick={onClick} aria-label={`${name}: ${STATE_LABEL[state]}. Tap to change.`}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors lg:min-h-9 ${style}`}>
      {state === "like" ? <CheckIcon className="size-4" /> : state === "avoid" ? <XIcon className="size-4" /> : null}
      {name}
      {state !== "none" ? <span className="text-xs font-medium opacity-80">{state === "like" ? "liked" : "avoided"}</span> : null}
    </button>
  );
}

/** Three explicit choices for one ingredient. Each button names its action, so nothing depends on counting taps. */
function TriState({ name, value, onChange }: { name: string; value: PrefState; onChange: (v: PrefState) => void }) {
  const btn = (v: PrefState, label: string, icon: React.ReactNode, on: string) => (
    <button type="button" role="radio" aria-checked={value === v} aria-label={`${label} ${name}`} onClick={() => onChange(v)}
      className={`flex min-h-10 flex-1 items-center justify-center gap-1 rounded-[0.5rem] px-1 text-xs font-semibold transition-colors lg:min-h-8 ${value === v ? on : "text-muted hover:text-fg"}`}>
      {icon}
      <span className="hidden sm:inline">{label}</span><span className="sr-only sm:hidden">{label}</span>
    </button>
  );
  return (
    <div role="radiogroup" aria-label={`${name} preference`} className="flex rounded-control border border-strong bg-surface2 p-0.5">
      {btn("like", "Like", <CheckIcon className="size-4" />, "bg-oksoft text-ok ring-1 ring-ok/50")}
      {btn("none", "Okay", <MinusIcon className="size-4" />, "bg-surface text-fg ring-1 ring-line")}
      {btn("avoid", "Avoid", <XIcon className="size-4" />, "bg-badsoft text-bad ring-1 ring-bad/50")}
    </div>
  );
}

type View = "all" | "like" | "avoid";

export function IngredientPicker({
  open,
  onClose,
  items,
  people,
  prefs,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  items: PickerIngredient[];
  people: { id: number; name: string }[];
  prefs: Record<number, PrefSet>;
  onChange: (personId: number, next: PrefSet) => void;
}) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("All");
  const [view, setView] = useState<View>("all");
  const [whoRaw, setWho] = useState<number>(people[0]?.id ?? 0);
  const who = people.some((p) => p.id === whoRaw) ? whoRaw : (people[0]?.id ?? 0);
  const groups = useMemo(() => Array.from(new Set(items.map((i) => i.group))), [items]);
  const current = prefs[who] ?? { liked: [], avoided: [] };
  const byslug = useMemo(() => new Map(items.map((i) => [i.slug, i])), [items]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => group === "All" || i.group === group)
      .filter((i) => view === "all" || stateOf(current, i.slug) === view)
      .filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.aliases.some((a) => a.toLowerCase().includes(needle)));
  }, [items, q, group, view, current]);

  const names = (slugs: string[]) => slugs.map((s) => byslug.get(s)).filter((i): i is PickerIngredient => !!i);
  const chips = pickerChips({ group, view, q });
  const clearNarrowing = () => { setQ(""); setGroup("All"); setView("all"); };
  const picks = [...names(current.liked).map((i) => ({ i, kind: "like" as const })), ...names(current.avoided).map((i) => ({ i, kind: "avoid" as const }))];
  const countIn = (g: string) => items.filter((i) => g === "All" || i.group === g).length;
  const pick = (slug: string, to: PrefState) => onChange(who, setState(current, slug, to));

  return (
    <Sheet open={open} onClose={onClose} title="Likes and avoids" full>
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-3 border-b border-line p-4 lg:px-5">
          <div className="flex flex-wrap items-center gap-3">
            {people.length > 1 ? (
              <Segmented value={String(who)} onChange={(v) => setWho(Number(v))} label="Choose person" options={people.map((p) => ({ value: String(p.id), label: p.name }))} />
            ) : null}
            <SearchField id="picker-search" label="Search ingredients" value={q} onChange={setQ} placeholder="Search by name, Hindi or Punjabi name" className="min-w-[14rem] flex-1 lg:max-w-md" />
            <Segmented<View> value={view} onChange={setView} label="Show" options={[{ value: "all", label: "All" }, { value: "like", label: `Liked ${current.liked.length}` }, { value: "avoid", label: `Avoided ${current.avoided.length}` }]} />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
            <Chip on={group === "All"} onClick={() => setGroup("All")}>All</Chip>
            {groups.map((g) => <Chip key={g} on={group === g} onClick={() => setGroup(g)}>{g}</Chip>)}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Aisle" className="hidden w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-line p-3 lg:block">
            {["All", ...groups].map((g) => (
              <button key={g} type="button" aria-current={group === g ? "true" : undefined} onClick={() => setGroup(g)}
                className={`flex min-h-10 w-full items-center justify-between rounded-control px-3 text-left text-sm font-semibold ${group === g ? "bg-primarysoft text-primary" : "hover:bg-surface2"}`}>
                {g}<span className="text-xs font-medium tabular-nums text-muted">{countIn(g)}</span>
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-5">
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {chips.length ? (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active filters">
                    {chips.map((c) => (
                      <Chip key={c.key} on removable label={c.label} onClick={() => (c.key === "group" ? setGroup("All") : c.key === "view" ? setView("all") : setQ(""))}>{c.label}</Chip>
                    ))}
                    <button type="button" onClick={clearNarrowing} className="min-h-11 px-1 text-sm font-semibold text-primary underline-offset-2 hover:underline lg:min-h-9">Clear all</button>
                  </div>
                ) : null}
                <p className="text-sm text-muted lg:ml-auto" aria-live="polite">{chips.length ? `${shown.length} of ${items.length}` : items.length} ingredients</p>
              </div>
              <p className="text-sm text-muted">Choose Like or Avoid on each. The rest stay Okay.</p>
              {picks.length ? (
                <details className="rounded-control border border-line bg-surface2 px-3 py-1 xl:hidden">
                  <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Your picks ({picks.length})</summary>
                  <ul className="flex flex-wrap gap-2 pb-2">
                    {picks.map(({ i, kind }) => (
                      <li key={i.slug}>
                        <button type="button" onClick={() => pick(i.slug, "none")} aria-label={`Remove ${i.name} from ${kind === "like" ? "liked" : "avoided"}`}
                          className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-xs font-semibold ${kind === "like" ? "border-ok bg-oksoft text-ok" : "border-bad bg-badsoft text-bad"}`}>
                          {i.name}<XIcon className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            {shown.length === 0 ? <p className="p-6 text-center text-muted">{q ? `Nothing matches "${q}".` : "Nothing here yet."}</p> : null}
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {shown.map((i) => {
                const st = stateOf(current, i.slug);
                return (
                  <li key={i.slug} className={`flex flex-col overflow-hidden rounded-card border bg-surface ${st === "like" ? "border-ok" : st === "avoid" ? "border-bad" : "border-line"}`}>
                    <div className="aspect-[16/9] w-full overflow-hidden bg-primarysoft">
                      {i.image ? <img src={i.image} alt="" loading="lazy" className="size-full object-cover" /> : <IngredientTile aisle={i.aisle} size="card" />}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-snug">{i.name}</p>
                        <p className="text-xs text-muted">{i.group}{i.density >= 8 ? ", protein-dense" : ""}</p>
                      </div>
                      <div className="mt-auto"><TriState name={i.name} value={st} onChange={(v) => pick(i.slug, v)} /></div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <aside aria-label="Your picks" className="hidden w-64 shrink-0 space-y-4 overflow-y-auto border-l border-line p-4 xl:block">
            {([["Liked", current.liked, "like"], ["Avoided", current.avoided, "avoid"]] as const).map(([title, slugs, kind]) => (
              <div key={title}>
                <h3 className="text-sm font-semibold">{title} <span className="font-normal text-muted">{slugs.length}</span></h3>
                {slugs.length === 0 ? <p className="mt-1 text-sm text-muted">None yet.</p> : (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {names(slugs).map((i) => (
                      <li key={i.slug}>
                        <button type="button" onClick={() => pick(i.slug, "none")} aria-label={`Remove ${i.name} from ${title.toLowerCase()}`}
                          className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold ${kind === "like" ? "border-ok bg-oksoft text-ok" : "border-bad bg-badsoft text-bad"}`}>
                          {i.name}<XIcon className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </aside>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface p-3 lg:px-5" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <Button variant="ghost" size="sm" onClick={() => onChange(who, { liked: [], avoided: [] })} disabled={current.liked.length + current.avoided.length === 0}>Clear all</Button>
          <Button onClick={onClose} className="min-w-32">Done</Button>
        </div>
      </div>
    </Sheet>
  );
}
