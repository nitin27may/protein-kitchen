import Link from "next/link";
import { Card, LinkButton, PageTitle } from "@/components/ui";
import type { RecipeCardData } from "@/lib/filters/recipes";

const STEPS = [
  ["Set a target", "Enter a protein target, or let the planner suggest one from height and weight."],
  ["Pick days and meals", "Choose how many days, which meals, and how long you want to spend cooking."],
  ["Shop and cook", "The plan builds a grocery list, night-before prep and a method with cues for every step."],
];

/** The signed-out Plan tab: the same layout as a member's Today page, with a call to make a plan and no household data. */
export function AnonymousHome({ highlights }: { highlights: RecipeCardData[] }) {
  return (
    <>
      <PageTitle title="Plan" sub="High-protein vegetarian meals, sized to your target." />
      <div className="space-y-4 px-4 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-semibold">Make a plan in about a minute</h2>
            <p className="mt-1 text-muted">Protein and calories are computed from sourced ingredient data. Nothing is saved until you create an account.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <LinkButton href="/plan/new" size="lg">Make a plan</LinkButton>
              <LinkButton href="/recipes" variant="secondary" size="lg">Browse recipes</LinkButton>
            </div>
          </Card>
          <section aria-labelledby="ideas">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 id="ideas" className="text-lg font-semibold">High-protein ideas</h2>
              <Link href="/recipes" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary">All recipes</Link>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {highlights.map((r) => (
                <li key={r.slug}>
                  <Link href={`/recipes/${r.slug}`} className="block h-full rounded-card border border-line bg-surface p-4 hover:border-primary">
                    <h3 className="font-semibold leading-snug">{r.name}</h3>
                    <p className="mt-1 font-display text-2xl font-bold tabular-nums">{Math.round(r.proteinG)}<span className="ml-1 text-sm font-medium text-muted">g protein</span></p>
                    <p className="text-sm text-muted tabular-nums">{Math.round(r.kcal)} kcal, {r.activeMin} min active</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside aria-label="How it works" className="space-y-4">
          <Card>
            <h2 className="text-lg font-semibold">How it works</h2>
            <ol className="mt-3 space-y-3">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="flex gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primarysoft font-display font-bold text-primary">{i + 1}</span>
                  <div><p className="font-semibold">{title}</p><p className="text-sm text-muted">{body}</p></div>
                </li>
              ))}
            </ol>
          </Card>
          <Card>
            <h2 className="text-lg font-semibold">Keep your plans</h2>
            <p className="mt-1 text-sm text-muted">An account saves plans, ticks groceries and remembers favourites and ratings.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <LinkButton href="/sign-up" size="sm">Create account</LinkButton>
              <LinkButton href="/sign-in" variant="secondary" size="sm">Sign in</LinkButton>
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
