"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ICONS } from "./Sidebar";

const tabs = [
  { href: "/", label: "Plan", icon: NAV_ICONS.plan, match: (p: string) => p === "/" || p.startsWith("/plan") },
  { href: "/recipes", label: "Recipes", icon: NAV_ICONS.recipes, match: (p: string) => p.startsWith("/recipes") },
  { href: "/ingredients", label: "Foods", icon: NAV_ICONS.ingredients, match: (p: string) => p.startsWith("/ingredients") },
  { href: "/groceries", label: "Groceries", icon: NAV_ICONS.groceries, match: (p: string) => p.startsWith("/groceries") },
];

export function BottomNav() {
  const path = usePathname();
  // Cook mode and form flows have their own full-width action bar.
  if (path.endsWith("/cook") || path === "/plan/new" || path.startsWith("/profiles/") ||
      ["/onboarding", "/sign-in", "/sign-up", "/verify-email", "/reset-password"].includes(path)) return null;
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 lg:hidden border-t border-line bg-surface/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <ul className="mx-auto flex max-w-2xl">
        {tabs.map((t) => {
          const active = t.match(path);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold ${active ? "text-primary" : "text-muted"}`}
              >
                <span className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${active ? "bg-primarysoft" : ""}`}>{t.icon}</span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
