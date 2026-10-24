import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { IngredientTile } from "@/components/IngredientTile";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecipeThumb } from "@/components/RecipeThumb";
import { expandRecipe } from "@/lib/grocery/aggregate";
import { aisleLabel } from "@/lib/format";
import { energySplit } from "@/lib/nutrition/energy";
import { perServing } from "@/lib/nutrition/macros";
import { targetFor } from "@/lib/nutrition/dri";
import { MICRO_GROUPS, MICRO_LABELS } from "@/lib/nutrition/labels";
import { recipeThumbs } from "@/lib/recipes/thumbs";
import { displayName } from "@/lib/schemas";
import { getData, getDb } from "@/lib/server/context";
import { listPeople } from "@/lib/server/queries";
import { PhotoCredit } from "@/components/photos/PhotoCredit";
import { photoIndex, photosOfIngredient } from "@/lib/server/photo-index";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const ing = getData().ingredients.get(slug);
  return { title: ing ? displayName(ing) : "Ingredient" };
}

const fmt = (n: number, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString("en-CA", { maximumFractionDigits: d });

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded-full border border-line bg-surface2 px-3 py-1 text-sm">{children}</span>;
}

export default async function IngredientPage({ params }: { params: Promise<{ slug: string }> }) {
  const member = await requirePageMember();
  const { slug } = await params;
  const data = getData();
  const ing = data.ingredients.get(slug);
  if (!ing) notFound();

  const sex = (await listPeople()).find((person) => person.id === member.personId)!.sex;
  const photoIdx = await photoIndex(await getDb());
  const cover = (await photosOfIngredient(await getDb(), slug)).find((x) => x.isCover);
  const micros = data.micros[slug]?.per100g ?? {};
  const p = ing.per100g;
  const e = energySplit(p.protein_g, p.carbs_g, p.fat_g);
  const density = p.kcal > 0 ? (p.protein_g / p.kcal) * 100 : 0;

  const labelOf = new Map(MICRO_LABELS.map((l) => [l.key, l]));
  const pctOf = (key: string, value: number) => {
    const dv = targetFor(key, sex);
    return dv ? (value / dv) * 100 : null;
  };

  const standouts = [{ key: "fibre_g", label: "Fibre", value: p.fibre_g }, ...MICRO_LABELS.map((l) => ({ key: l.key, label: l.label, value: micros[l.key] ?? 0 }))]
    .flatMap((n) => {
      const pct = pctOf(n.key, n.value);
      return pct !== null && pct >= 20 ? [{ label: n.label, pct }] : [];
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);

  const groups = MICRO_GROUPS.map((g) => ({
    title: g.title,
    rows: g.keys.flatMap((k) => {
      const l = labelOf.get(k);
      const v = micros[k];
      return l && typeof v === "number" ? [{ ...l, value: v, pct: pctOf(k, v) }] : [];
    }),
  })).filter((g) => g.rows.length);

  const usedIn = [...data.recipes.values()]
    .filter((r) => r.kind === "recipe")
    .filter((r) => {
      try {
        return expandRecipe(r.slug, r.servings, data.recipes).has(slug);
      } catch {
        return false;
      }
    })
    .map((r) => ({ r, protein: perServing(r.slug, data.recipes, data.ingredients).protein_g }))
    .sort((a, b) => b.protein - a.protein);

  const stats: [string, string, string][] = [
    ["Energy", `${Math.round(p.kcal)}`, "kcal"],
    ["Protein", fmt(p.protein_g), "g"],
    ["Carbs", fmt(p.carbs_g), "g"],
    ["Fat", fmt(p.fat_g), "g"],
    ["Fibre", fmt(p.fibre_g), "g"],
  ];

  return (
    <div className="px-4 pb-12 pt-4">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/ingredients" className="inline-flex min-h-11 items-center font-semibold text-primary">← All ingredients</Link>
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="aspect-[4/3] w-full overflow-hidden rounded-card bg-primarysoft">
            {cover ? (
              <img src={cover.url} alt={displayName(ing)} className="size-full object-cover" />
            ) : (
              <IngredientTile aisle={ing.aisle} name={displayName(ing)} state={ing.state} size="card" />
            )}
          </div>
          {cover ? <div className="mt-1"><PhotoCredit cover={cover} /></div> : null}

          <div className="mt-4 rounded-card border border-line bg-surface p-4">
            <h2 className="text-lg font-semibold">Buying and diet</h2>
            <dl className="mt-2 space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Aisle</dt><dd className="font-medium">{aisleLabel(ing.aisle)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">State</dt><dd className="font-medium capitalize">{ing.state}</dd></div>
              {ing.cooked_yield ? <div className="flex justify-between gap-3"><dt className="text-muted">Cooked yield</dt><dd className="font-medium">1 g dry gives {fmt(ing.cooked_yield)} g cooked</dd></div> : null}
              {ing.pack_size_g ? <div className="flex justify-between gap-3"><dt className="text-muted">Usual pack</dt><dd className="font-medium">{ing.pack_size_g} g</dd></div> : null}
              {ing.where_to_buy.length ? <div className="flex justify-between gap-3"><dt className="text-muted">Where to buy</dt><dd className="text-right font-medium">{ing.where_to_buy.join(", ")}</dd></div> : null}
              <div className="flex justify-between gap-3"><dt className="text-muted">Dairy</dt><dd className="font-medium">{ing.is_dairy ? "Yes" : "No"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Onion or garlic</dt><dd className="font-medium">{ing.contains_onion_garlic ? "Yes" : "No"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Data source</dt><dd className="font-medium">{ing.source} {ing.source_id}</dd></div>
            </dl>
          </div>
        </aside>

        <div className="mt-6 min-w-0 space-y-6 lg:mt-0">
          <header>
            <h1 className="text-3xl font-bold leading-tight">{displayName(ing)}</h1>
            {ing.name !== displayName(ing) ? <p className="text-sm text-muted">{ing.name}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Tag>{aisleLabel(ing.aisle)}</Tag>
              <Tag>{ing.state}</Tag>
              {ing.is_dairy ? <Tag>dairy</Tag> : null}
              {ing.is_pantry_staple ? <Tag>pantry staple</Tag> : null}
              {ing.aliases.slice(0, 4).map((a) => <Tag key={a}>{a}</Tag>)}
            </div>
          </header>

          {ing.note ? (
            <section className="rounded-card border border-primary/30 bg-primarysoft p-4">
              <h2 className="text-lg font-semibold text-primary">How to get the most from it</h2>
              <p className="mt-1 text-lg leading-snug">{ing.note}</p>
            </section>
          ) : null}

          <section aria-labelledby="macros">
            <h2 id="macros" className="mb-2 text-lg font-semibold text-fg">Per 100 g ({ing.state})</h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {stats.map(([label, value, unit]) => (
                <div key={label} className="rounded-card border border-line bg-surface p-4">
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className="mt-1 font-display text-4xl font-bold tabular-nums">{value}<span className="ml-1 text-base font-medium text-muted">{unit}</span></dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 rounded-card border border-line bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">Where the energy comes from</p>
                <p className="text-sm text-muted"><strong className="text-fg">{fmt(density)} g</strong> protein per 100 kcal</p>
              </div>
              <div role="img" aria-label={`Protein ${Math.round(e.p)} percent, carbs ${Math.round(e.c)} percent, fat ${Math.round(e.f)} percent of energy`}
                className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-surface2">
                <span className="bg-primary" style={{ width: `${e.p}%` }} />
                <span className="bg-warn" style={{ width: `${e.c}%` }} />
                <span className="bg-muted" style={{ width: `${e.f}%` }} />
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <li><span className="mr-1.5 inline-block size-2.5 rounded-full bg-primary" />Protein {Math.round(e.p)}%</li>
                <li><span className="mr-1.5 inline-block size-2.5 rounded-full bg-warn" />Carbs {Math.round(e.c)}%</li>
                <li><span className="mr-1.5 inline-block size-2.5 rounded-full bg-muted" />Fat {Math.round(e.f)}%</li>
              </ul>
            </div>
          </section>

          {standouts.length ? (
            <section aria-labelledby="standouts">
              <h2 id="standouts" className="mb-2 text-lg font-semibold text-fg">Standout nutrients</h2>
              <ul className="flex flex-wrap gap-2">
                {standouts.map((s) => (
                  <li key={s.label} className="rounded-full border border-ok/30 bg-oksoft px-3 py-1.5 text-sm font-medium text-ok">{s.label} <span className="tabular-nums">{Math.round(s.pct)}%</span> of a day</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">Share of a daily need in 100 g, for an adult {sex === "female" ? "woman" : "man"} aged 31 to 50 (Health Canada DRI). It is not what you absorb.</p>
            </section>
          ) : null}

          {groups.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h2 className="mb-2 text-lg font-semibold text-fg">{g.title}</h2>
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {g.rows.map((r) => (
                  <li key={r.key} className="rounded-control border border-line bg-surface p-3">
                    <p className="text-sm text-muted">{r.label}</p>
                    <p className="text-lg font-semibold tabular-nums">{fmt(r.value, r.digits)} <span className="text-sm font-normal text-muted">{r.unit}</span></p>
                    {r.pct !== null ? (
                      <>
                        <div role="img" aria-label={`${Math.round(r.pct)} percent of a daily need`} className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface2">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, r.pct)}%` }} />
                        </div>
                        <p className="mt-1 text-xs text-muted">{Math.round(r.pct)}% of daily need</p>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 ? <p className="text-sm text-muted">No micronutrient data for this item.</p> : null}
          <p className="text-xs text-muted">Source: {ing.source} {ing.source_id}. Values the source does not report are left out, not shown as zero.</p>

          {usedIn.length ? (
            <section aria-labelledby="used-in">
              <h2 id="used-in" className="mb-2 text-lg font-semibold text-fg">Used in {usedIn.length} {usedIn.length === 1 ? "recipe" : "recipes"}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {usedIn.slice(0, 12).map(({ r, protein }) => (
                  <li key={r.slug}>
                    <Link href={`/recipes/${r.slug}`} className="flex gap-3 rounded-card border border-line bg-surface p-3 hover:bg-surface2">
                      <RecipeThumb image={photoIdx.recipes.get(r.slug) ?? null} thumbs={recipeThumbs(r.slug, data.recipes, data.ingredients, photoIdx.ingredients)} label={r.family} className="aspect-[4/3] w-24 shrink-0 rounded-control" />
                      <div className="min-w-0">
                        <p className="font-semibold leading-snug">{r.name}</p>
                        <p className="text-sm text-muted tabular-nums"><strong className="text-fg">{Math.round(protein)} g</strong> protein per serving</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
