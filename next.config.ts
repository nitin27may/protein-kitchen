import type { NextConfig } from "next";

// lib/export/pdf.ts loads the Roboto TTFs by a computed path at runtime, which file tracing cannot see.
// Route keys are picomatch globs against the route path; "[id]" would read as a character class, so use "*".
export const PDF_ROUTES = ["/api/plan/*/export", "/api/plan/*/schedule"];
export const PDF_FONT_GLOBS = ["./node_modules/pdfmake/build/fonts/Roboto/*.ttf"];

const config: NextConfig = {
  // `pnpm dev` and a production build share `.next` and can corrupt each other. Set NEXT_DIST_DIR (for example
  // `.next-build`) when building or serving a production build while a dev server is running.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3", "exceljs", "pdfmake", "sharp"],
  poweredByHeader: false,
  // Server-only (not NEXT_PUBLIC): inlined into server code at build time for /api/health.
  env: { APP_RELEASE_SHA: process.env.APP_RELEASE_SHA ?? "" },
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
    ];
    return [
      // Everything is private by default. Shared library photos are public: their route sets its own cache headers.
      { source: "/((?!library-photos/).*)", headers: [{ key: "Cache-Control", value: "private, no-store" }, ...common] },
      { source: "/library-photos/:path*", headers: common },
    ];
  },
  // Photos are resized on the phone to a few hundred KB; the default 1 MB limit is too tight for a large one.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  outputFileTracingIncludes: {
    "/**": ["./data/**/*", "./db/migrations/**/*"],
    ...Object.fromEntries(PDF_ROUTES.map((route) => [route, PDF_FONT_GLOBS])),
  },
};

export default config;
