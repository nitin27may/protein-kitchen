import type { Metadata } from "next";
import Link from "next/link";
import * as s from "@/lib/db/schema";
import { PageTitle } from "@/components/ui";
import { needsCredit } from "@/lib/photos/candidates";
import { getData, getDb } from "@/lib/server/context";
import { displayName } from "@/lib/schemas";

export const metadata: Metadata = { title: "Photo credits" };
export const dynamic = "force-dynamic";

interface Row {
  key: string;
  name: string;
  title: string | null;
  author: string | null;
  licence: string | null;
  licenceUrl: string | null;
  sourceUrl: string | null;
}

/** Credits for approved photos from Wikimedia Commons and Openverse. Your own photos need none. */
export default async function CreditsPage() {
  const data = getData();
  const db = await getDb();
  const recipeNames = new Map((await db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes)).map((r) => [r.id, data.recipes.get(r.slug)?.name ?? r.slug]));
  const all = (await db.select().from(s.photos)).filter((p) => p.origin !== "upload");
  const toRow = (p: (typeof all)[number]): Row => ({
    key: p.uid,
    name: p.recipeId !== null ? (recipeNames.get(p.recipeId) ?? "Recipe") : (data.ingredients.get(p.ingredientSlug!) ? displayName(data.ingredients.get(p.ingredientSlug!)!) : p.ingredientSlug!),
    title: p.title, author: p.author, licence: p.licence, licenceUrl: p.licenceUrl, sourceUrl: p.sourceUrl,
  });
  const recipes = all.filter((p) => p.recipeId !== null).map(toRow).sort((a, b) => a.name.localeCompare(b.name));
  const ingredients = all.filter((p) => p.recipeId === null).map(toRow).sort((a, b) => a.name.localeCompare(b.name));

  const section = (title: string, list: Row[]) => (
    <section className="px-4 pb-6 lg:px-2">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {list.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface lg:columns-2 lg:gap-0 lg:divide-y-0 [&>li]:break-inside-avoid [&>li]:border-b [&>li]:border-line">
          {list.map((r) => (
            <li key={r.key} className="px-3 py-2 text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="block text-muted">
                {r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="underline">{r.title ?? "source"}</a> : r.title}, {r.author ?? "unknown author"},{" "}
                {r.licenceUrl ? <a href={r.licenceUrl} target="_blank" rel="noreferrer" className="underline">{r.licence}</a> : r.licence}
                {r.licence && !needsCredit(r.licence) ? " (no credit required)" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <>
      <PageTitle title="Photo credits" sub="Photos you approved from Wikimedia Commons and Openverse. Your own photos are not listed." />
      <p className="px-4 pb-4 text-sm lg:px-2"><Link href="/photos/review" className="inline-flex min-h-11 items-center font-semibold text-primary underline">Review more photos</Link></p>
      {section(`Recipes (${recipes.length})`, recipes)}
      {section(`Ingredients (${ingredients.length})`, ingredients)}
    </>
  );
}
