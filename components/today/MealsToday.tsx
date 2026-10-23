import Link from "next/link";
import { RecipeThumb } from "@/components/RecipeThumb";
import { MacroLine } from "@/components/ui";
import { SLOT_LABEL } from "@/lib/format";
import type { MealView } from "./types";

export function MealsToday({ title, meals }: { title: string; meals: MealView[] }) {
  if (meals.length === 0) return <p className="px-1 text-sm text-muted">No meals planned for this day.</p>;
  return (
    <section aria-labelledby="meals-h">
      <h2 id="meals-h" className="mb-2 text-lg font-semibold">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {meals.map((m) => (
          <li key={m.id}>
            <Link href={`/recipes/${m.slug}`} className="flex h-full overflow-hidden rounded-card border border-line bg-surface hover:border-primary sm:flex-col">
              <RecipeThumb image={m.image} thumbs={m.thumbs} label={SLOT_LABEL[m.slot] ?? m.slot} className="aspect-[4/3] w-28 shrink-0 sm:aspect-[16/9] sm:w-full" />
              <div className="min-w-0 flex-1 p-3">
                <p className="text-sm font-semibold text-primary">{SLOT_LABEL[m.slot] ?? m.slot}</p>
                <p className="text-base font-semibold leading-snug">{m.name}</p>
                <MacroLine protein={m.proteinG} kcal={m.kcal} minutes={m.leftover ? undefined : m.activeMin} />
                {m.leftover ? <p className="mt-1 text-sm text-muted">Leftover, no cooking</p> : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
