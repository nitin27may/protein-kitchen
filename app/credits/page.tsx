import type { Metadata } from "next";
import { PageTitle } from "@/components/ui";
import { getData } from "@/lib/server/context";

export const metadata: Metadata = { title: "Photo credits" };

export default function CreditsPage() {
  const data = getData();
  const recipes = [...data.recipes.values()].filter((r) => r.image && r.image_credit).map((r) => ({ name: r.name, credit: r.image_credit! }));
  const ingredients = [...data.ingredients.values()].filter((i) => i.image && i.image_credit).map((i) => ({ name: i.display_name ?? i.name, credit: i.image_credit! }));
  const section = (title: string, rows: { name: string; credit: string }[]) => (
    <section className="px-4 pb-6 lg:px-2">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <ul className="divide-y divide-line rounded-card border border-line bg-surface lg:columns-2 lg:gap-0 lg:divide-y-0 [&>li]:break-inside-avoid [&>li]:border-b [&>li]:border-line">
        {rows.map((r) => (
          <li key={r.name} className="px-3 py-2 text-sm">
            <span className="font-medium">{r.name}</span>
            <span className="block text-muted">{r.credit}</span>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <>
      <PageTitle title="Photo credits" sub="Photos are freely licensed images from Wikimedia Commons." />
      {section(`Recipes (${recipes.length})`, recipes)}
      {section(`Ingredients (${ingredients.length})`, ingredients)}
    </>
  );
}
