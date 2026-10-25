import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export function PublicNavigation() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[88rem] flex-wrap items-center justify-between gap-x-4 px-4 py-2">
        <Link href="/" className="inline-flex min-h-11 items-center text-lg font-bold text-primary">Protein Kitchen</Link>
        <ThemeToggle />
        <nav aria-label="Public navigation" className="flex w-full flex-wrap gap-x-4 sm:w-auto">
          <Link href="/recipes" className="inline-flex min-h-11 items-center font-semibold">Recipes</Link>
          <Link href="/ingredients" className="inline-flex min-h-11 items-center font-semibold">Ingredients</Link>
          <Link href="/sign-in" className="inline-flex min-h-11 items-center text-primary">Sign in</Link>
          <Link href="/sign-up" className="inline-flex min-h-11 items-center font-semibold text-primary">Create account</Link>
        </nav>
      </div>
    </header>
  );
}
