"use client";

import { useState, useTransition } from "react";
import { setRecipeFeedback } from "@/app/actions";
import { Markdown } from "@/components/Markdown";
import { LinksCard } from "@/components/links/LinksCard";
import { LinksProvider } from "@/components/links/LinksProvider";
import { StepLinks } from "@/components/links/StepLinks";
import { PartsSection } from "@/components/parts/PartsSection";
import { Sheet } from "@/components/Sheet";
import { RecipeThumb } from "@/components/RecipeThumb";
import { MinusIcon, PlusIcon } from "@/components/icons";
import { Banner, Button, Chip, LinkButton, Pill, SectionCard, Segmented } from "@/components/ui";
import { round1 } from "@/lib/format";
import type { PartModes } from "@/lib/parts/mode";
import { flattenParts } from "@/lib/recipes/linkview";
import type { OwnedLink } from "@/lib/recipes/linkview";
import type { UsedIn } from "@/lib/recipes/parts";
import type { PartAdvance, PartView } from "@/lib/recipes/timeline";

export interface DetailItem {
  kind: "ingredient" | "component";
  name: string;
  state?: string;
  /** File name in public/ingredient-images. */
  image?: string | null;
  grams: number;
  /** For components: what the portion is made of, at the base servings. */
  parts?: { name: string; state: string; grams: number }[];
}

export interface DetailProps {
  slug: string;
  name: string;
  image: string | null;
  thumbs: string[];
  baseServings: number;
  prepMin: number;
  activeMin: number;
  totalMin: number;
  fridgeDays: number;
  equipment: string[];
  cuisine: string;
  macros: { protein: number; kcal: number; carbs: number; fat: number; fibre: number };
  tags: string[];
  anchors: string[];
  items: DetailItem[];
  advancePrep: { text: string }[];
  steps: { text: string; cue: string | null; tip: string | null; timerSec: number | null; technique: { slug: string; title: string; body: string } | null }[];
  storage: string;
  nutrients: { label: string; unit: string; amount: number; target: number | null; partial: boolean }[];
  quality: { freeSugarG: number; totalSugarG: number; sodiumMg: number; satFatG: number; kcal: number; score: number; partial: boolean; lowSugar: boolean; light: boolean; dense: boolean };
  targetFor: string;
  feedback: { favourite: boolean; banned: boolean; rating: number | null; tested: boolean };
  techniques: { slug: string; title: string }[];
  /** "component" for a part of other meals, such as hummus. */
  kind: "recipe" | "component";
  /** The parts this meal is made of, at its base servings. Empty for a recipe without components. */
  parts: PartView[];
  /** Saved Make / Buy / Have choices for the plan in the URL, or empty. */
  partModes: PartModes;
  /** The plan the choices are saved to, from `?plan=` in the URL. */
  planId: number | null;
  /** Hands-on minutes that can be done ahead because the parts keep. */
  makeAheadMin: number;
  /** The meal's own advance prep (not its parts'). */
  mealAdvancePrep: PartAdvance[];
  /** For a part: the meals that use it. */
  usedIn: UsedIn[];
  /** Saved links for this page, plus those saved on its parts' own pages. */
  links: OwnedLink[];
}

const fmtGrams = (g: number) => (g < 10 ? `${round1(g)} g` : `${Math.round(g)} g`);

export function RecipeDetail(p: DetailProps) {
  const [servings, setServings] = useState(p.baseServings);
  const [fb, setFb] = useState(p.feedback);
  const [tech, setTech] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmBan, setConfirmBan] = useState(false);
  const [pending, start] = useTransition();
  const factor = servings / p.baseServings;

  function update(patch: Parameters<typeof setRecipeFeedback>[1], optimistic: Partial<typeof fb>) {
    const before = fb;
    setFb((c) => ({ ...c, ...optimistic }));
    setError(null);
    start(async () => {
      const r = await setRecipeFeedback(p.slug, patch);
      if (!r.ok) {
        setFb(before);
        setError(r.error);
      }
    });
  }

  const stat = (label: string, value: number, unit: string, accent = false) => (
    <div key={label} className="rounded-control bg-surface2 px-2 py-2.5 text-center">
      <dd className={`font-display text-2xl font-bold tabular-nums leading-none ${accent ? "text-accent" : ""}`}>{Math.round(value)}<span className="text-sm font-medium text-muted">{unit}</span></dd>
      <dt className="mt-1 text-xs text-muted">{label}</dt>
    </div>
  );

  const qualityRows: [string, string, string][] = [
    ["Free sugars", String(round1(p.quality.freeSugarG)), p.quality.kcal > 0 ? `g, ${Math.round((p.quality.freeSugarG * 4 * 100) / p.quality.kcal)}% of energy` : "g"],
    ["Total sugars", `${round1(p.quality.totalSugarG)}${p.quality.partial ? " *" : ""}`, "g"],
    ["Sodium", `${Math.round(p.quality.sodiumMg)}${p.quality.partial ? " *" : ""}`, "mg"],
    ["Saturated fat", `${round1(p.quality.satFatG)}${p.quality.partial ? " *" : ""}`, "g"],
  ];

  return (
    <LinksProvider recipeSlug={p.slug} links={p.links} parts={flattenParts(p.parts)} mealStepCount={p.steps.length}>
    <div className="pb-10">
      {p.image || p.thumbs.length ? <RecipeThumb image={p.image} thumbs={p.thumbs} label="" className="aspect-[4/3] w-full lg:hidden" /> : null}

      <div className="px-4 pt-4 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-2 lg:pt-5 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        {/* Left: what it is and how much. Stays in view while the method scrolls. */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pb-2">
          {p.image || p.thumbs.length ? <RecipeThumb image={p.image} thumbs={p.thumbs} label="" className="hidden aspect-[4/3] w-full rounded-card lg:flex" /> : null}
          {p.image ? <p className="-mt-2 text-xs text-muted"><a href="/credits" className="underline">Photo credit</a></p> : null}

          <div>
            <h1 className="text-3xl font-bold leading-tight">{p.name}</h1>
            <p className="mt-1 text-sm text-muted">{p.cuisine.charAt(0).toUpperCase() + p.cuisine.slice(1)}, {p.activeMin} min active, {p.totalMin} min total, keeps {p.fridgeDays} {p.fridgeDays === 1 ? "day" : "days"}{p.equipment.length ? `, ${p.equipment.join(", ")}` : ""}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.tags.includes("high-protein") ? <Pill tone="ok">High protein</Pill> : null}
              {p.tags.includes("high-fibre") ? <Pill tone="info">High fibre</Pill> : null}
              {p.tags.includes("protein-dense") ? <Pill tone="ok">Protein-dense</Pill> : null}
              {p.quality.dense ? <Pill tone="ok">Nutrient-dense</Pill> : null}
              {p.quality.light ? <Pill tone="info">Light</Pill> : null}
              {p.quality.lowSugar ? <Pill tone="info">Low sugar</Pill> : null}
              {fb.tested ? <Pill tone="ok">Tested{fb.rating ? ` ${fb.rating}/5` : ""}</Pill> : <Pill>Draft: not cooked yet</Pill>}
            </div>
          </div>

          {error ? <Banner tone="bad">{error}</Banner> : null}

          <LinkButton href={`/recipes/${p.slug}/cook${p.planId ? `?plan=${p.planId}` : ""}`} size="lg" className="w-full">Start cooking</LinkButton>

          <section aria-labelledby="per" className="rounded-card border border-line bg-surface p-4">
            <h2 id="per" className="mb-3 text-base font-semibold">Per serving</h2>
            <dl className="grid grid-cols-5 gap-1.5">
              {stat("Protein", p.macros.protein, " g", true)}
              {stat("Energy", p.macros.kcal, " kcal")}
              {stat("Carbs", p.macros.carbs, " g")}
              {stat("Fat", p.macros.fat, " g")}
              {stat("Fibre", p.macros.fibre, " g")}
            </dl>
            {p.anchors.length ? <p className="mt-3 text-sm text-muted">Most of the protein comes from {p.anchors.join(" and ")}.</p> : null}
          </section>

          <section aria-labelledby="serv" className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-4">
            <div>
              <h2 id="serv" className="text-base font-semibold">Servings</h2>
              <p className="text-sm text-muted">Ingredient weights scale with this.</p>
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Servings">
              <Button variant="secondary" size="sm" aria-label="Fewer servings" disabled={servings <= 0.5} onClick={() => setServings((x) => Math.max(0.5, x - 0.5))} className="size-11 px-0 lg:size-9"><MinusIcon className="size-5" /></Button>
              <span className="w-12 text-center font-display text-2xl font-bold tabular-nums" aria-live="polite">{servings}</span>
              <Button variant="secondary" size="sm" aria-label="More servings" disabled={servings >= 24} onClick={() => setServings((x) => x + 0.5)} className="size-11 px-0 lg:size-9"><PlusIcon className="size-5" /></Button>
            </div>
          </section>

          <LinksCard />

          {p.advancePrep.length ? (
            <Banner tone="warn" title="Plan ahead">
              <ul className="list-disc pl-5">{p.advancePrep.map((a) => <li key={a.text}>{a.text}</li>)}</ul>
            </Banner>
          ) : null}

          <section aria-labelledby="notes" className="space-y-3 rounded-card border border-line bg-surface p-4">
            <h2 id="notes" className="text-base font-semibold">Your notes on this recipe</h2>
            <div className="flex flex-wrap gap-2">
              <Chip on={fb.favourite} onClick={() => !pending && update({ favourite: !fb.favourite }, { favourite: !fb.favourite })}>Favourite</Chip>
              <Chip on={fb.tested} onClick={() => !pending && update({ tested: !fb.tested, ...(fb.tested ? { rating: null } : {}) }, { tested: !fb.tested, ...(fb.tested ? { rating: null } : {}) })}>Cooked and tested</Chip>
            </div>
            {fb.tested ? (
              <div>
                <p className="mb-1 text-sm font-semibold">Rating</p>
                <Segmented value={fb.rating ? String(fb.rating) : ""} onChange={(v) => !pending && update({ rating: Number(v) }, { rating: Number(v), tested: true })} label="Rating out of 5" className="w-full"
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
                <p className="mt-1 text-sm text-muted">1 or 2 stops the recipe being suggested.</p>
              </div>
            ) : null}
            {confirmBan || fb.banned ? (
              fb.banned ? (
                <Button variant="secondary" size="sm" disabled={pending} onClick={() => update({ banned: false }, { banned: false })}>Allow this recipe again</Button>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">Never suggest this recipe again?</p>
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" disabled={pending} onClick={() => { update({ banned: true }, { banned: true }); setConfirmBan(false); }}>Yes, hide it</Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmBan(false)}>Keep</Button>
                  </div>
                </div>
              )
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmBan(true)}>Never suggest this</Button>
            )}
          </section>
        </aside>

        {/* Right: the cooking content, using the full width. */}
        <div className="mt-6 space-y-5 lg:mt-0">
          <SectionCard id="ing" title="Ingredients" description={`For ${servings} ${servings === 1 ? "serving" : "servings"}. Weights are grams; dry means weighed before soaking or cooking.`}>
            <ul className="grid gap-x-8 lg:grid-cols-2">
              {p.items.map((it, i) => (
                <li key={`${it.name}-${i}`} className="border-b border-line py-2 last:border-b-0">
                  <div className="flex min-h-9 items-center gap-3">
                    {it.image ? <img src={`/ingredient-images/${it.image}`} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover" /> : <span className="size-9 shrink-0 rounded-control bg-surface2" aria-hidden="true" />}
                    <span className="min-w-0 flex-1">{it.name}{it.state === "dry" ? <span className="text-sm text-muted"> (dry)</span> : null}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{fmtGrams(it.grams * factor)}</span>
                  </div>
                  {it.parts ? (
                    <details className="ml-12 text-sm text-muted">
                      <summary className="min-h-9 cursor-pointer py-1">Made from</summary>
                      <ul className="pb-1">
                        {it.parts.map((pt) => <li key={pt.name} className="flex justify-between gap-3"><span>{pt.name}</span><span className="tabular-nums">{fmtGrams(pt.grams * factor)}</span></li>)}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </SectionCard>

          {p.parts.length ? <PartsSection parts={p.parts} initialModes={p.partModes} planId={p.planId} factor={factor} makeAheadMin={p.makeAheadMin} mealAdvancePrep={p.mealAdvancePrep} /> : null}

          {p.kind === "component" ? (
            <SectionCard id="used" title="Used in" description="This is part of other meals. Open one to choose whether to make, buy or already have it.">
              {p.usedIn.length === 0 ? (
                <p className="text-sm text-muted">No meal uses this yet.</p>
              ) : (
                <ul className="grid gap-2 md:grid-cols-2">
                  {p.usedIn.map((u) => (
                    <li key={u.slug}>
                      <a href={`/recipes/${u.slug}${p.planId ? `?plan=${p.planId}` : ""}`} className="flex min-h-12 items-center justify-between gap-3 rounded-control border border-line px-3 py-2 hover:bg-surface2">
                        <span className="min-w-0 font-semibold leading-snug">{u.name}{u.kind === "component" ? <span className="font-normal text-muted"> (part)</span> : null}</span>
                        <span className="shrink-0 text-sm tabular-nums text-muted">{round1(u.gramsPerServing)} g a serving</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : null}

          <section aria-labelledby="steps">
            <h2 id="steps" className="mb-1 text-lg font-semibold">{p.parts.length ? "Putting it together" : "Method"}</h2>
            {p.parts.length ? <p className="mb-3 text-sm text-muted">The steps for the meal itself. Each part's own steps are above.</p> : <div className="mb-2" />}
            <ol className="space-y-3">
              {p.steps.map((s, i) => (
                <li key={i} className="flex gap-4 rounded-card border border-line bg-surface p-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primarysoft font-display text-base font-bold text-primary">{i + 1}</span>
                  <div className="min-w-0 max-w-prose">
                    <p className="text-base leading-relaxed">{s.text}</p>
                    {s.cue ? <p className="mt-2 rounded-control bg-oksoft px-3 py-2 text-sm text-ok"><span className="font-semibold">Done when: </span>{s.cue}</p> : null}
                    {s.tip ? <p className="mt-2 text-sm text-muted"><span className="font-semibold text-fg">Tip: </span>{s.tip}</p> : null}
                    <StepLinks partSlug={null} stepNo={i + 1} />
                    {s.timerSec || s.technique ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {s.timerSec ? <Pill>{Math.round(s.timerSec / 60)} min timer</Pill> : null}
                        {s.technique ? <Button variant="ghost" size="sm" onClick={() => setTech(s.technique)}>Technique: {s.technique.title}</Button> : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard id="store" title="Storing and reheating">
              <p className="text-base leading-relaxed">{p.storage}</p>
            </SectionCard>

            <SectionCard id="sugar" title="Sugar, salt and fat" description="Per serving">
              <dl className="grid grid-cols-2 gap-2">
                {qualityRows.map(([label, value, unit]) => (
                  <div key={label} className="rounded-control bg-surface2 px-3 py-2">
                    <dt className="text-sm text-muted">{label}</dt>
                    <dd className="tabular-nums"><strong className="font-display text-xl">{value}</strong> <span className="text-sm text-muted">{unit}</span></dd>
                  </div>
                ))}
              </dl>
              <details className="mt-3 text-sm text-muted">
                <summary className="min-h-11 cursor-pointer py-2 font-semibold text-primary">How to read this</summary>
                <div className="space-y-2 pb-2">
                  <p>Low sugar here means free sugars are 5% of the meal's energy or less. WHO advises under 10%, and ideally under 5%.</p>
                  <p>The nutrient score is a similar idea to the Nutrient Rich Foods index: fibre, protein, minerals and vitamins per 100 kcal, minus saturated fat, free sugars and sodium. This meal scores <strong className="text-fg">{Math.round(p.quality.score)}</strong>. Nutrient-dense means the top third of the library. It is the app's own version, not the published index.</p>
                  {p.quality.partial ? <p>* Some ingredients have no reported value in the food tables, so these amounts are a minimum.</p> : null}
                </div>
              </details>
            </SectionCard>
          </div>

          {p.nutrients.length ? (
            <SectionCard id="nutr" title="Nutrients per serving" description={`Compared with the daily target for adults aged 31 to 50 (${p.targetFor}). A star means some ingredients have no reported value, so the real amount is at least this much.`}>
              <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                {p.nutrients.map((n) => {
                  const pct = n.target ? (n.amount / n.target) * 100 : null;
                  return (
                    <li key={n.label} className="rounded-control border border-line px-3 py-2">
                      <p className="text-sm text-muted">{n.label}{n.partial ? " *" : ""}</p>
                      <p className="tabular-nums"><strong className="font-display text-lg">{round1(n.amount)}</strong> <span className="text-sm text-muted">{n.unit}</span></p>
                      {pct !== null ? (
                        <>
                          <div role="img" aria-label={`${Math.round(pct)} percent of the daily target`} className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                          <p className="mt-0.5 text-xs text-muted">{Math.round(pct)}% of daily</p>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </div>

      <Sheet open={!!tech} onClose={() => setTech(null)} title={tech?.title ?? "Technique"}>
        <div className="p-4">{tech ? <Markdown>{tech.body}</Markdown> : null}</div>
      </Sheet>
    </div>
    </LinksProvider>
  );
}
