import { safeHref } from "@/lib/library-photos/model";
import { needsCredit } from "@/lib/photos/candidates";
import type { CreditedPhoto } from "@/lib/photos/view";

export type CreditRow = CreditedPhoto & { name: string };

function Section({ title, list }: { title: string; list: CreditRow[] }) {
  return (
    <section className="px-4 pb-6 lg:px-2">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {list.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface lg:columns-2 lg:gap-0 lg:divide-y-0 [&>li]:break-inside-avoid [&>li]:border-b [&>li]:border-line">
          {list.map((r) => {
            const source = safeHref(r.sourceUrl);
            const licence = safeHref(r.licenceUrl);
            return (
              <li key={r.uid} className="px-3 py-2 text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="block text-muted">
                  {source ? <a href={source} target="_blank" rel="noreferrer" className="underline">{r.title ?? "source"}</a> : r.title}, {r.author ?? "unknown author"},{" "}
                  {licence ? <a href={licence} target="_blank" rel="noreferrer" className="underline">{r.licence}</a> : r.licence}
                  {r.licence && !needsCredit(r.licence) ? " (no credit required)" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Recipe and ingredient credits. Shared by the signed-out and the member view of /credits. */
export function CreditsList({ rows }: { rows: CreditRow[] }) {
  const recipes = rows.filter((r) => r.subjectKind === "recipe");
  const ingredients = rows.filter((r) => r.subjectKind === "ingredient");
  return (
    <>
      <Section title={`Recipes (${recipes.length})`} list={recipes} />
      <Section title={`Ingredients (${ingredients.length})`} list={ingredients} />
    </>
  );
}
