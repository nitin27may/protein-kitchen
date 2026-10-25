"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

function icon(d: string): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="1.25rem" height="1.25rem" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

/** Shared by the desktop rail and the phone bottom bar so both show the same destinations. */
export const NAV_ICONS = {
  plan: icon("M3 6.5A1.5 1.5 0 014.5 5h11A1.5 1.5 0 0117 6.5v9a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 15.5v-9zM3 9h14M7 3v3M13 3v3"),
  recipes: icon("M4 5.5C4 4.7 4.7 4 5.5 4H16v11H5.5A1.5 1.5 0 004 16.5v-11zM4 16.5A1.5 1.5 0 005.5 18H16v-3"),
  ingredients: icon("M16 4C8 4 4 8 4 13c0 1 .3 2 .8 3 1 .5 2 .8 3 .8 5 0 8.200-4 8.200-12.800zM4.800 16C7 12 10 9.500 13 8"),
  groceries: icon("M3 7h14l-1.300 8.200a1.500 1.500 0 01-1.500 1.300H5.800a1.500 1.500 0 01-1.500-1.300L3 7zM7 7l2-3.500M13 7l-2-3.500"),
  profiles: icon("M10 10a3.500 3.500 0 100-7 3.500 3.500 0 000 7zM3.500 17c.5-3 3.200-5 6.500-5s6 2 6.500 5"),
  settings: icon("M10 12.500a2.500 2.500 0 100-5 2.500 2.500 0 000 5zM16 10l1.500-1-1-2-1.800.3-1.200-1.200.3-1.800-2-1-1 1.500h-1.600l-1-1.500-2 1 .3 1.800L5.300 6.300 3.500 6l-1 2 1.500 1v1.600l-1.500 1 1 2 1.800-.3 1.200 1.200-.3 1.800 2 1 1-1.500h1.600l1 1.500 2-1-.3-1.800 1.200-1.200 1.800.3 1-2-1.500-1V10z"),
};

const links = [
  { href: "/", label: "Plan", hint: "Today and your meal plans", icon: NAV_ICONS.plan, match: (p: string) => p === "/" || p.startsWith("/plan") },
  { href: "/recipes", label: "Recipes", hint: "Browse and cook", icon: NAV_ICONS.recipes, match: (p: string) => p.startsWith("/recipes") },
  { href: "/ingredients", label: "Ingredients", hint: "Nutrition and how to eat", icon: NAV_ICONS.ingredients, match: (p: string) => p.startsWith("/ingredients") },
  { href: "/groceries", label: "Groceries", hint: "What to buy", icon: NAV_ICONS.groceries, match: (p: string) => p.startsWith("/groceries") },
  { href: "/profiles", label: "Profiles", hint: "People and targets", icon: NAV_ICONS.profiles, match: (p: string) => p.startsWith("/profiles") },
];

const settings = { href: "/settings", label: "Settings", icon: NAV_ICONS.settings, match: (p: string) => p.startsWith("/settings") };

function NavLink({ l, active }: { l: { href: string; label: string; icon: ReactNode; hint?: string }; active: boolean }) {
  return (
    <Link href={l.href} aria-current={active ? "page" : undefined} title={l.hint}
      className={`flex min-h-11 items-center gap-3 rounded-control px-3 text-[0.95rem] font-semibold transition-colors ${active ? "bg-primarysoft text-primary" : "text-fg hover:bg-surface2"}`}>
      <span className={active ? "text-primary" : "text-muted"}>{l.icon}</span>
      {l.label}
    </Link>
  );
}

/** Desktop navigation rail. Phones use the header and bottom bar instead. */
export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <Link href="/" className="px-5 pb-5 pt-6 font-display text-xl font-bold leading-none text-primary">Protein Kitchen</Link>
      <nav aria-label="Main" className="flex-1 space-y-1 px-3">
        {links.map((l) => <NavLink key={l.href} l={l} active={l.match(path)} />)}
      </nav>
      <div className="space-y-2 border-t border-line p-3">
        <Link href="/account" className="flex min-h-11 items-center rounded-control px-3 font-semibold text-primary">Your account</Link>
        <NavLink l={settings} active={settings.match(path)} />
        <ThemeToggle variant="segmented" />
        <div className="flex gap-3 px-1 pt-1 text-xs text-muted">
          <Link href="/photos/review" className="underline-offset-2 hover:underline">Review photos</Link>
          <Link href="/credits" className="underline-offset-2 hover:underline">Photo credits</Link>
        </div>
      </div>
    </aside>
  );
}
