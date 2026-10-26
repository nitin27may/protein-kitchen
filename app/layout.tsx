import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque } from "next/font/google";
import Link from "next/link";
import { BottomNav } from "@/components/BottomNav";
import { HeaderSettingsLink, Sidebar } from "@/components/Sidebar";
import { RegisterSW } from "@/components/RegisterSW";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PendingIntentReplay } from "@/components/auth/PendingIntentReplay";
import { RequireAccountProvider } from "@/components/auth/RequireAccount";
import { photoReviewEnabled } from "@/lib/photos/review-flag";
import { shellAccount } from "@/lib/auth/public-access";
import { SignOutButton } from "@/components/auth/SignOutButton";
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
  // A session cookie without a finished profile (mid-onboarding) is "setup", not a visitor: the shell must not offer signup again.
  const account = await shellAccount();
  const anonymous = account.kind === "visitor";
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
          <Sidebar account={account.kind} photoReview={photoReviewEnabled()} />
          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
              <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
                <Link href="/" className="inline-flex min-h-11 items-center whitespace-nowrap text-lg font-bold text-primary">
                  Protein Kitchen
                </Link>
                <div className="flex min-w-0 items-center">
                  {account.kind === "visitor" ? (
                    <>
                      <ThemeToggle />
                      <Link href="/sign-in" className="flex min-h-11 min-w-0 items-center rounded-control px-3 text-right text-sm leading-tight font-semibold text-primary">
                        Sign in / Create account
                      </Link>
                    </>
                  ) : account.kind === "setup" ? (
                    <SignOutButton variant="ghost" />
                  ) : (
                    <>
                      <Link href="/account" className="flex min-h-11 items-center rounded-control px-2 text-sm font-semibold text-primary">
                        Account
                      </Link>
                      <HeaderSettingsLink />
                    </>
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
        {account.kind === "member" ? <PendingIntentReplay /> : null}
        </RequireAccountProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
