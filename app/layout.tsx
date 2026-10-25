import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque } from "next/font/google";
import Link from "next/link";
import { BottomNav } from "@/components/BottomNav";
import { Sidebar } from "@/components/Sidebar";
import { RegisterSW } from "@/components/RegisterSW";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PendingIntentReplay } from "@/components/auth/PendingIntentReplay";
import { RequireAccountProvider } from "@/components/auth/RequireAccount";
import { optionalPageMember } from "@/lib/auth/public-access";
import { hasSessionCookie } from "@/lib/auth/session-cookie";
import "./globals.css";

const body = Atkinson_Hyperlegible_Next({ subsets: ["latin"], variable: "--nf-body", display: "swap" });
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--nf-display", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Protein Kitchen", template: "%s · Protein Kitchen" },
  description: "Vegetarian meal plans with computed protein, groceries and cook mode.",
  appleWebApp: { capable: true, title: "Kitchen", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0f6b7a" },
    { media: "(prefers-color-scheme: dark)", color: "#0e171c" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await optionalPageMember()) !== null;
  // A session cookie without a finished profile (mid-onboarding) is not a visitor: the gate must not offer signup again.
  const anonymous = !signedIn && !await hasSessionCookie();
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable}`}>
      <head>
        {/* Apply a saved theme before first paint so there is no flash of the wrong colours. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("pk-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}` }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-surface focus:p-3">
          Skip to content
        </a>
        <RequireAccountProvider anonymous={anonymous}>
        <div className="lg:flex">
          <Sidebar signedIn={signedIn} />
          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
              <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
                <Link href="/" className="inline-flex min-h-11 items-center whitespace-nowrap text-lg font-bold text-primary">
                  Protein Kitchen
                </Link>
                <div className="flex items-center">
                  <ThemeToggle />
                  {signedIn ? (
                    <>
                      <Link href="/account" className="flex min-h-11 items-center rounded-control px-2 text-sm font-semibold text-primary">
                        Account
                      </Link>
                      <Link href="/settings" className="flex min-h-11 items-center rounded-control px-3 text-base font-semibold text-muted hover:bg-surface2">
                        Settings
                      </Link>
                    </>
                  ) : (
                    <Link href="/sign-in" className="flex min-h-11 items-center whitespace-nowrap rounded-control px-3 text-sm font-semibold text-primary">
                      Sign in / Create account
                    </Link>
                  )}
                </div>
              </div>
            </header>
            <main id="main" className="mx-auto max-w-2xl lg:max-w-[88rem] lg:px-6">
              {children}
            </main>
          </div>
        </div>
        <BottomNav />
        {signedIn ? <PendingIntentReplay /> : null}
        </RequireAccountProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
